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

// Normalize a WhatsApp jid OR a bare number: "+1555...@s.whatsapp.net" ->
// "1555...@s.whatsapp.net", "11111111111@lid" stays, bare "+1555..." ->
// digits only. Used for reply routing (baileys 7 accepts @lid jids directly).
function normalizeJid(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.includes("@")) {
    const [local, ...rest] = s.split("@");
    // strip a device suffix ("1555...:10") before digit-normalizing
    const digits = local.split(":")[0].replace(/[^0-9]/g, "");
    if (!digits) return null;
    return `${digits}@${rest.join("@")}`;
  }
  return normalizeNumber(s);
}

// WhatsApp now identifies contacts by opaque LIDs (@lid) instead of phone
// numbers, and baileys persists the mapping as lid-mapping-*.json files in the
// auth dir (two flavors: lid-mapping-<phone>.json -> the LID, and
// lid-mapping-<lid>_reverse.json -> the phone). Build both directions so the
// allowlist and the envelope's display number work in either form.
export async function loadLidMap(authDir) {
  const map = { lidToPhone: {}, phoneToLid: {} };
  let files = [];
  try {
    files = await readdir(authDir);
  } catch {
    return map; // no auth yet (pre-link): empty map, allowlist still works for phone-form jids
  }
  for (const f of files) {
    const m = f.match(/^lid-mapping-(\d+)(_reverse)?\.json$/);
    if (!m) continue;
    const key = m[1];
    let val = null;
    try {
      val = String(JSON.parse(await readFile(path.join(authDir, f), "utf8"))).replace(/[^0-9]/g, "");
    } catch {
      continue;
    }
    if (!val) continue;
    if (m[2]) {
      // lid-mapping-<lid>_reverse.json -> the phone
      map.lidToPhone[key] = val;
      map.phoneToLid[val] = key;
    } else {
      // lid-mapping-<phone>.json -> the LID
      map.phoneToLid[key] = val;
      map.lidToPhone[val] = key;
    }
  }
  return map;
}

// Resolve an inbound remoteJid to { jid (normalized, reply-routable), phone
// (digits; LID resolved via the map when the jid is @lid), isLid }.
export function resolveSender(rawJid, lidMap = { lidToPhone: {}, phoneToLid: {} }) {
  const jid = normalizeJid(rawJid);
  if (!jid) return { jid: null, phone: null, isLid: false };
  const isLid = jid.endsWith("@lid");
  if (isLid) {
    const digits = jid.split("@")[0];
    return { jid, phone: lidMap.lidToPhone[digits] || null, isLid: true };
  }
  return { jid, phone: jid.split("@")[0], isLid: false };
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

// Track the most recent inbound sender so wa-reply can default to it. Stores
// the reply-routable jid (LID or phone form, normalized).
export async function rememberSender(bridgeDir, number) {
  const jid = normalizeJid(number);
  if (!jid) return;
  await mkdir(bridgeDir, { recursive: true });
  await writeFile(path.join(bridgeDir, "last-sender.json"), JSON.stringify({ jid, at: Date.now() }));
}

export async function lastSender(bridgeDir) {
  try {
    const d = JSON.parse(await readFile(path.join(bridgeDir, "last-sender.json"), "utf8"));
    return d.jid || null;
  } catch {
    return null;
  }
}
