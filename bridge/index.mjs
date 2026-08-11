// pi-team WhatsApp bridge daemon.
// Runs as its own process (not inside pi): receives messages from allowlisted
// numbers, delivers them into the Dispatcher's pi-team inbox, and relays the
// Dispatcher's wa-reply queue back to WhatsApp.
//
// Session auth lives in ~/.pi/wa-bridge/auth (OUTSIDE the repo) — never commit it.
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { loadConfig, isAllowed, buildInboundEnvelope, deliverInbound, drainOutbox, rememberSender } from "./lib.mjs";

const cfg = loadConfig();
const log = (...a) => console.log(new Date().toISOString(), ...a);

log(`pi-team WA bridge
  bridge dir : ${cfg.bridgeDir}   (session auth lives here — outside the repo)
  team       : ${cfg.team}  member: ${cfg.memberId}
  owners     : ${cfg.owners.length ? cfg.owners.join(", ") : "NONE (fail closed — nobody can message it)"}`);

if (!cfg.owners.length) {
  console.error("error: WA_OWNERS is not set — add your number(s) and restart. Example:\n  WA_OWNERS=+15551234567 node index.mjs");
  process.exit(1);
}

const { state, saveCreds } = await useMultiFileAuthState(`${cfg.bridgeDir}/auth`);
const { version } = await fetchLatestBaileysVersion();

const sock = makeWASocket({
  version,
  auth: state,
  printQRInTerminal: false, // we print our own (once, scannable)
  logger: pino({ level: "silent" }), // baileys internals stay quiet; we log ourselves
});

let lastQr = null;

sock.ev.on("connection.update", async (update) => {
  const { connection, lastDisconnect, qr } = update;
  if (qr) {
    lastQr = qr;
    console.log("\n=== SCAN THIS QR in WhatsApp: Settings -> Linked devices -> Link a device ===\n");
    qrcode.generate(qr, { small: true });
  }
  if (connection === "open") {
    lastQr = null;
    log("connected to WhatsApp. Waiting for messages from owner numbers.");
  }
  if (connection === "close") {
    const code = lastDisconnect?.error?.output?.statusCode;
    log("connection closed", code || "");
    if (code === DisconnectReason.loggedOut) {
      log("logged out from the phone — delete", `${cfg.bridgeDir}/auth`, "and rescan to re-link.");
      process.exit(0);
    }
    // reconnect (baileys reconnects automatically; nothing else to do here)
  }
});

sock.ev.on("creds.update", saveCreds);

// ---- inbound: owner texts -> Dispatcher inbox ----------------------------
sock.ev.on("messages.upsert", async ({ messages, type }) => {
  for (const m of messages) {
    if (m.key?.fromMe) continue; // ignore our own outgoing
    const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text;
    if (!text) continue;
    const number = (m.key.remoteJid || "").replace("@s.whatsapp.net", "");
    if (!isAllowed(number, cfg.owners)) {
      log("ignored message from non-owner:", number);
      continue;
    }
    log("inbound from", number, "->", String(text).slice(0, 80));
    await rememberSender(cfg.bridgeDir, number);
    const envelope = buildInboundEnvelope({ from: number, fromName: `You (${number})`, body: text });
    try {
      await deliverInbound(cfg.teamsRoot, cfg.team, cfg.memberId, envelope);
      log("delivered to", cfg.team, "/", cfg.memberId);
    } catch (e) {
      log("delivery failed:", e?.message);
    }
  }
});

// ---- outbound: Dispatcher's wa-reply queue -> WhatsApp --------------------
setInterval(async () => {
  try {
    const replies = await drainOutbox(cfg.bridgeDir);
    for (const r of replies) {
      const jid = `${r.to || (await lastSender(cfg.bridgeDir))}@s.whatsapp.net`;
      if (!jid.startsWith("@s.whatsapp.net")) {
        await sock.sendMessage(jid, { text: String(r.body || "") });
        log("sent to", jid);
      }
    }
  } catch (e) {
    log("outbox error:", e?.message);
  }
}, 1500);

process.on("SIGINT", () => { log("stopping (session persists — no rescan needed next time)"); process.exit(0); });
process.on("SIGTERM", () => process.exit(0));
