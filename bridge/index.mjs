// pi-team WhatsApp bridge daemon.
// Runs as its own process (not inside pi): receives messages from allowlisted
// numbers, delivers them into the Dispatcher's pi-team inbox, and relays the
// Dispatcher's wa-reply queue back to WhatsApp.
//
// Session auth lives in ~/.pi/wa-bridge/auth (OUTSIDE the repo) — never commit it.
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from "baileys";
import QRCode from "qrcode";
import pino from "pino";
import { loadConfig, isAllowed, buildInboundEnvelope, deliverInbound, drainOutbox, rememberSender, lastSender, loadLidMap, resolveSender } from "./lib.mjs";

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

let sock = null;
let lidMap = { lidToPhone: {}, phoneToLid: {} };
let lastLidScan = 0;

async function refreshLidMap(force = false) {
  // Contacts are discovered continuously; rescan the auth dir at most once a
  // minute (or when a new creds.update lands) — reading ~hundreds of tiny
  // files per message would be wasteful.
  const now = Date.now();
  if (!force && now - lastLidScan < 60_000) return;
  lastLidScan = now;
  lidMap = await loadLidMap(`${cfg.bridgeDir}/auth`);
}

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(`${cfg.bridgeDir}/auth`);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
  version,
  auth: state,
  // Custom browser fingerprint (pattern proven in production by Hermes Agent's
  // bridge: standard Browsers.* fingerprints get flagged after repeated failed
  // links; a custom UA string is accepted). Do NOT switch back to Browsers.*.
  browser: ["pi-team", "Chrome", "120.0"],
  // Required for Baileys 7.x: without this, incoming messages that need E2EE
  // session re-establishment are silently dropped (msg.message === null) —
  // which stalls the linking handshake itself. From Hermes Agent's bridge.
  getMessage: async () => ({ conversation: "" }),
  syncFullHistory: false,
  markOnlineOnConnect: false,
  printQRInTerminal: false, // we print our own (once, scannable)
  // 'warn' (not silent): baileys' own warnings/errors carry the real reason
  // behind a failed link — e.g. protocol rejections — straight to bridge.log.
  logger: pino({ level: "warn" }),
});

  let lastQr = null;
  let printedQr = false;
  let pairDone = false;

  sock.ev.on("connection.update", async (update) => {
  const { connection, lastDisconnect, qr } = update;
  if (qr) {
    lastQr = qr;
    try {
      // Plain-text QR (no ANSI colors): always write the LATEST to qr.txt so
      // it survives log scrolling/rotation; print to console once per attempt.
      const text = await QRCode.toString(qr, { type: "utf8", small: true });
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(cfg.bridgeDir, { recursive: true });
      await writeFile(
        `${cfg.bridgeDir}/qr.txt`,
        `Scan within ~20s (the QR rotates). WhatsApp -> Settings -> Linked devices -> Link a device.\n\n${text}\n`,
      );
      if (!printedQr) {
        printedQr = true;
        console.log("\n=== SCAN THIS QR (fresh copy always at " + cfg.bridgeDir + "/qr.txt) ===\n");
        console.log(text);
      }
    } catch (e) {
      console.error("QR render failed:", e?.message);
    }
  }
  if (connection === "open") {
    lastQr = null;
    printedQr = false;
    log("connected to WhatsApp. Waiting for messages from owner numbers.");
  }
  if (connection === "connecting" && cfg.pair && !pairDone) {
    pairDone = true;
    // The socket must be fully up before requestPairingCode works; retry with
    // delays instead of calling it on the first 'connecting' tick.
    (async () => {
      for (let attempt = 1; attempt <= 8; attempt++) {
        try {
          const code = await sock.requestPairingCode(cfg.pair);
          const pretty = `${code.slice(0, 4)}-${code.slice(4)}`;
          console.log(`\n=== PAIRING CODE (instead of QR): ${pretty} ===`);
          console.log("On the phone: WhatsApp -> Settings -> Linked devices -> Link a device -> Link with phone number instead -> enter the code.");
          const { writeFile } = await import("node:fs/promises");
          await writeFile(`${cfg.bridgeDir}/pair-code.txt`, `${pretty}\n`, "utf8");
          return;
        } catch (e) {
          log(`pairing attempt ${attempt}/8 failed: ${e?.message}`);
          await new Promise((r) => setTimeout(r, 4000));
        }
      }
    })();
  }
  if (connection === "open") {
    log("connected to WhatsApp ✓ (session live)");
  }
  if (connection === "close") {
    const code = lastDisconnect?.error?.output?.statusCode;
    const msg = lastDisconnect?.error?.message || lastDisconnect?.error?.toString?.() || "";
    log("connection closed", code || "", msg ? `— ${msg}` : "");
    if (code === DisconnectReason.loggedOut) {
      log("logged out from the phone — delete", `${cfg.bridgeDir}/auth`, "and rescan to re-link.");
      process.exit(0);
    }
    // 515 = WhatsApp asked us to restart (normal after pairing — the session
    // is saved and the reconnect continues with the new creds).
    // 408 = "QR refs attempts ended" — the QR expired with no scan; keep
    // cycling so a fresh scannable QR is always waiting.
    // Any other close = transient; reconnect too.
    const delay = code === 515 || code === 408 ? 1000 : 3000;
    log(code === 515 ? "↻ WhatsApp requested restart (515) — reconnecting"
        : code === 408 ? "↻ QR expired without a scan (408) — rotating a fresh one"
        : "↻ reconnecting...");
    setTimeout(startSocket, delay);
  }
  });

  sock.ev.on("creds.update", async () => { saveCreds(); await refreshLidMap(true); });

  // ---- inbound: owner texts -> Dispatcher inbox --------------------------
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    await refreshLidMap();
    for (const m of messages) {
      if (m.key?.fromMe) continue; // ignore our own outgoing
      const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text;
      if (!text) continue;
      // WhatsApp now routes inbound DMs by LID (@lid) rather than phone
      // number; resolve the LID to the owner's phone for the allowlist.
      let { jid, phone } = resolveSender(m.key.remoteJid, lidMap);
      if (!phone && jid?.endsWith("@lid")) {
        // The mapping file may have been written by this very message —
        // force one refresh and retry before giving up (fail closed).
        await refreshLidMap(true);
        ({ jid, phone } = resolveSender(m.key.remoteJid, lidMap));
      }
      if (!phone || !isAllowed(phone, cfg.owners)) {
        log("ignored message from non-owner:", m.key.remoteJid, phone ? `(resolved ${phone})` : "(no lid mapping)");
        continue;
      }
      log("inbound from", phone, "->", String(text).slice(0, 80));
      await rememberSender(cfg.bridgeDir, jid);
      const envelope = buildInboundEnvelope({ from: phone, fromName: `You (${phone})`, body: text });
      try {
        await deliverInbound(cfg.teamsRoot, cfg.team, cfg.memberId, envelope);
        log("delivered to", cfg.team, "/", cfg.memberId);
      } catch (e) {
        log("delivery failed:", e?.message);
      }
    }
  });
}

// ---- outbound: Dispatcher's wa-reply queue -> WhatsApp --------------------
setInterval(async () => {
  try {
    const replies = await drainOutbox(cfg.bridgeDir);
    for (const r of replies) {
      // to/lastSender may be a full jid ("11111111111@lid" or
      // "1555...@s.whatsapp.net") or a bare number; only append the domain
      // for bare numbers. baileys 7 sends to @lid jids directly.
      const raw = String(r.to || (await lastSender(cfg.bridgeDir)) || "").trim();
      if (!raw) continue;
      const jid = raw.includes("@") ? raw : `${raw}@s.whatsapp.net`;
      await sock.sendMessage(jid, { text: String(r.body || "") });
      log("sent to", jid);
    }
  } catch (e) {
    log("outbox error:", e?.message);
  }
}, 1500);

process.on("SIGINT", () => { log("stopping (session persists — no rescan needed next time)"); process.exit(0); });
process.on("SIGTERM", () => process.exit(0));

startSocket().catch((e) => { log("socket start failed:", e?.message); process.exit(1); });
