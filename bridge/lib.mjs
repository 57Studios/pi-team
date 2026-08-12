// Pure helpers for the WhatsApp bridge — no socket code, unit-testable.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// Config: all paths default OUTSIDE the repo (bridge dir ~/.pi/wa-bridge).
export function loadConfig(env = process.env) {
  const bridgeDir = env.PI_WA_DIR?.trim() || path.join(env.HOME || "/tmp", ".pi", "wa-bridge");
  const teamsRoot = env.PI_TEAM_DIR?.trim() || path.join(env.HOME || "/tmp", ".pi", "teams");
  const owners = (env.WA_OWNERS || "")
    .split(/[,\s]+/)
    .map((n) => normalizeNumber(n))
    .filter(Boolean);
  return {
    bridgeDir,
    teamsRoot,
    owners,
    team: env.WA_TEAM?.trim() || "Dispatch",
    memberId: env.WA_MEMBER_ID?.trim() || "dispatcher-main",
    // Optional pairing-code linking (more reliable than QR): set WA_PAIR to
    // your number and enter the 8-digit code on the phone instead of scanning.
    pair: env.WA_PAIR?.trim() || null,
  };
}

// Normalize a phone number to E.164-ish form: digits, strip leading +/00, keep 0.
export function normalizeNumber(raw) {
  const s = String(raw || "").replace(/[^0-9]/g, "");
  return s.replace(/^00/, "") || null;
}

export function isAllowed(number, owners) {
  if (!owners.length) return false; // no allowlist = nobody (fail closed)
  const n = normalizeNumber(number);
  return n ? owners.includes(n) : false;
}

// Envelope written into the Dispatcher's pi-team inbox. Same shape the bus
// writes, so the Dispatcher's watcher auto-reads it (wake: true -> turn).
export function buildInboundEnvelope({ from, fromName, body, ts = Date.now() }) {
  return {
    id: `wa_${ts}_${randomUUID().slice(0, 6)}`,
    type: "wa",
    ts,
    from: `wa:${normalizeNumber(from) || "unknown"}`,
    fromName: fromName || "WhatsApp",
    fromRole: "external",
    fromTeam: "WhatsApp",
    to: null,
    subject: "whatsapp",
    body: String(body || ""),
    priority: "normal",
    wake: true,
    isReply: false,
    replyTo: null,
  };
}

export function inboxDir(teamsRoot, team, memberId) {
  return path.join(teamsRoot, team, "inbox", memberId);
}

export async function deliverInbound(teamsRoot, team, memberId, envelope) {
  const dir = inboxDir(teamsRoot, team, memberId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${envelope.id}.json`), JSON.stringify(envelope, null, 2));
  return envelope.id;
}

// Outbox: one file per queued reply, drained in order by the daemon.
export function outboxDir(bridgeDir) {
  return path.join(bridgeDir, "outbox");
}

let _seq = 0;
export async function enqueueReply(bridgeDir, entry) {
  const dir = outboxDir(bridgeDir);
  await mkdir(dir, { recursive: true });
  // Filename order = send order: ms + zero-padded sequence handles same-ms
  // bursts; uuid suffix guarantees uniqueness.
  const file = path.join(dir, `${Date.now()}-${String(_seq++).padStart(6, "0")}-${randomUUID().slice(0, 4)}.json`);
  await writeFile(file, JSON.stringify(entry, null, 2));
  return file;
}

export async function drainOutbox(bridgeDir) {
  const dir = outboxDir(bridgeDir);
  let files = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      out.push(JSON.parse(await readFile(full, "utf8")));
      await unlink(full); // ack after read: best-effort delivery
    } catch {
      await rename(full, `${full}.bad`).catch(() => {});
    }
  }
  return out;
}

// Track the most recent inbound sender so wa-reply can default to it.
export async function rememberSender(bridgeDir, number) {
  const n = normalizeNumber(number);
  if (!n) return;
  await mkdir(bridgeDir, { recursive: true });
  await writeFile(path.join(bridgeDir, "last-sender.json"), JSON.stringify({ jid: n, at: Date.now() }));
}

export async function lastSender(bridgeDir) {
  try {
    const d = JSON.parse(await readFile(path.join(bridgeDir, "last-sender.json"), "utf8"));
    return d.jid || null;
  } catch {
    return null;
  }
}
