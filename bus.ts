// pi-team bus: a shared-filesystem message bus for pi agent teams.
//
// Multiple pi instances (each a "member") cooperate by reading/writing a
// shared team directory. No server, no ports: just atomic file operations on
// a directory all members can see (default ~/.pi/teams; override with
// PI_TEAM_DIR or --dir to point at a synced folder for remote members).
//
// Pure Node.js (no pi imports) so this file can be unit-tested directly with
// `node test/bus.test.mjs`.

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const TEAMS_ROOT_DEFAULT = path.join(os.homedir(), ".pi", "teams");
export const TEAM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const BOARD_TOPIC_RE = /^[A-Za-z0-9._-]{1,64}$/;
// True when a member record is unreachable: graceful shutdown (offline) or a
// heartbeat that has gone stale (crash / power loss).
export function isMemberDead(m, now = Date.now()) {
  return !m || m.status === "offline" || now - (m.lastSeen || 0) > STALE_MEMBER_MS;
}

// A same-name occupant is reclaimable when its session is dead: it marked
// itself offline (graceful shutdown) or its heartbeat has gone stale. Live
// members touch lastSeen every HEARTBEAT_MS, so a stale lastSeen means the
// process is gone (crash, power loss) — names of dead sessions are free.
export const STALE_MEMBER_MS = 2 * 60 * 1000;
export const HEARTBEAT_MS = 60 * 1000;
// Locks are held for milliseconds; anything older than this is a dead lock
// (process killed mid-operation) and safe to reclaim.
export const STALE_LOCK_MS = 5000;

export function teamsRoot(env = process.env) {
  const v = env.PI_TEAM_DIR?.trim();
  return v || TEAMS_ROOT_DEFAULT;
}

// Resolve a team name to its exact on-disk name (case-insensitive fuzzy
// fallback), so `--team zilla` / `team join zilla` find "Zilla".
export async function resolveTeamName(root, name) {
  const exact = String(name || "").trim();
  if (!exact) return null;
  if (await pathExists(teamDir(root, exact))) return exact;
  // root IS the teams directory (teamDir(root, team) === root/team).
  let entries = [];
  try {
    entries = await fs.promises.readdir(root);
  } catch {
    return null;
  }
  const hit = entries.find((e) => e.toLowerCase() === exact.toLowerCase());
  return hit || null;
}

async function pathExists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

export function teamDir(root, team) {
  return path.join(root, team);
}

export function inboxDir(root, team, memberId) {
  return path.join(teamDir(root, team), "inbox", memberId);
}

export function boardDir(root, team, storeDir) {
  return path.join(storeDir || teamDir(root, team), "board");
}

// Task/board store resolution: when a member works inside a repo that has an
// agent-team/ directory, the task board is PER-PROJECT there (<repo>/agent-team/
// tasks.json + board/). Otherwise it falls back to the team board. The audit
// log, inboxes, and notifications always stay team-level.
export function resolveTaskStore(root, team, cwd) {
  if (cwd) {
    try {
      if (fs.existsSync(path.join(cwd, "agent-team"))) {
        return { dir: path.join(cwd, "agent-team"), kind: "project" };
      }
    } catch { /* cwd may not exist */ }
  }
  return { dir: teamDir(root, team), kind: "team" };
}

export function validTeamName(team) {
  return TEAM_NAME_RE.test(team || "");
}

export async function teamExists(root, team) {
  try {
    await fsp.access(teamDir(root, team), fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, file);
}

export async function writeTextAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const body = String(text ?? "");
  await fsp.writeFile(tmp, body.endsWith("\n") ? body : body + "\n", "utf8");
  await fsp.rename(tmp, file);
}

export async function appendLine(file, line) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, line + "\n", "utf8");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mutex via a lock directory. All writers to members.json / team.json go
// through here so concurrent pi instances never lose each other's updates.
export async function withDirLock(dir, fn, timeoutMs = 4000) {
  const lock = path.join(dir, ".lock");
  const start = Date.now();
  for (;;) {
    try {
      await fsp.mkdir(lock);
      break;
    } catch {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`lock timed out (${path.basename(dir)})`);
      }
      try {
        const st = await fsp.stat(lock);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          await fsp.rm(lock, { recursive: true, force: true });
        }
      } catch {
        /* lock disappeared already */
      }
      await sleep(40 + Math.floor(Math.random() * 60));
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}

export function withTeamLock(root, team, fn, timeoutMs = 4000) {
  return withDirLock(teamDir(root, team), fn, timeoutMs);
}

// ---------------------------------------------------------------------------
// Team lifecycle
// ---------------------------------------------------------------------------

export async function createTeam(root, team, opts = {}) {
  if (!validTeamName(team)) {
    return {
      ok: false,
      error: `Invalid team name "${team}". Use letters, digits, dots, dashes, underscores (max 64 chars).`,
    };
  }
  const dir = teamDir(root, team);
  if (await teamExists(root, team)) {
    const meta = await readJson(path.join(dir, "team.json"), {});
    return { ok: true, existing: true, team: { name: team, dir, ...meta } };
  }
  await fsp.mkdir(path.join(dir, "board"), { recursive: true });
  await fsp.mkdir(path.join(dir, "inbox"), { recursive: true });
  const meta = {
    name: team,
    created: Date.now(),
    createdBy: opts.name || null,
    // autoRespond: when true, an idle member auto-starts a turn when a DM
    // arrives (max 3 auto-turns/min). Default ON so incoming messages are
    // read automatically (no "prompt your agent" step); coordinators can
    // turn it off with team config --auto_respond false.
    autoRespond: opts.autoRespond !== false,
    // interject: when true, a busy member sees incoming DMs before its next
    // LLM call (soft interrupt, like jcode). Default on.
    interject: opts.interject !== false,
    note: "pi-team shared team directory. Edit team.json to tune behavior, then tell members to re-read.",
  };
  await writeJsonAtomic(path.join(dir, "team.json"), meta);
  await writeJsonAtomic(path.join(dir, "members.json"), { members: {} });
  await appendLine(
    path.join(dir, "log.jsonl"),
    JSON.stringify({ ts: Date.now(), event: "team_created", by: opts.name || null }),
  );
  return { ok: true, existing: false, team: { name: team, dir, ...meta } };
}

export async function loadTeam(root, team) {
  if (!validTeamName(team)) return null;
  if (!(await teamExists(root, team))) return null;
  const meta = await readJson(path.join(teamDir(root, team), "team.json"), { name: team });
  return { name: team, dir: teamDir(root, team), ...meta };
}

// Toggle team-level settings (autoRespond, interject). Coordinator-gated in
// the tool/command layer.
export async function setTeamSetting(root, team, patch) {
  if (!(await teamExists(root, team))) {
    return { ok: false, error: `Team "${team}" does not exist.` };
  }
  return withTeamLock(root, team, async () => {
    const file = path.join(teamDir(root, team), "team.json");
    const meta = await readJson(file, {});
    if (patch.autoRespond !== undefined) meta.autoRespond = Boolean(patch.autoRespond);
    if (patch.interject !== undefined) meta.interject = Boolean(patch.interject);
    if (patch.searchUrl !== undefined) meta.searchUrl = String(patch.searchUrl).trim().slice(0, 300);
    if (patch.autoTimers !== undefined) {
      // Standing cadence timers: [{ name, minutes, body, tag }] — the
      // extension auto-arms them for the matching member at session start
      // and re-arms after each fire. No model cooperation needed.
      meta.autoTimers = (Array.isArray(patch.autoTimers) ? patch.autoTimers : [])
        .filter((a) => a && a.name)
        .map((a) => ({
          name: String(a.name).trim(),
          minutes: Math.max(1, Number(a.minutes) || 15),
          body: String(a.body || "").slice(0, 500),
          tag: String(a.tag || `${a.name}_${Date.now()}`).slice(0, 60),
        }));
    }
    await writeJsonAtomic(file, meta);
    return { ok: true, team: meta };
  });
}

export async function loadMembers(root, team) {
  const data = await readJson(path.join(teamDir(root, team), "members.json"), {
    members: {},
  });
  return data.members || {};
}

function sanitizeName(name) {
  return String(name || "").trim().slice(0, 40);
}

function sanitizeRole(role) {
  // Normalize separators: "coordinator,", "coordinator+reviewer", "coord, reviewer"
  // all become "coordinator, reviewer". Handles naive tokenizers that split
  // quoted multi-role values on spaces.
  const tokens = String(role || "")
    .split(/[,+]/)
    .map((r) => r.trim())
    .filter(Boolean);
  return tokens.join(", ").slice(0, 40) || "agent";
}

// Normalize a role string to a set of role tokens. Roles are free-form but a
// member may hold several (e.g. "coordinator, reviewer"); tokens are split on
// commas/plus signs and matched case-insensitively.
export function roleSet(role) {
  return String(role || "")
    .split(/[,+]/)
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
}

// Custom role names map to built-in capabilities so teams can use their own
// vocabulary (e.g. Hub/Math/Executor/Scout for trading) and still get the
// coordinator/planner/implementer/researcher/reviewer machinery.
const ROLE_ALIASES = {
  coordinator: ["hub", "boss", "lead", "manager", "captain", "conductor", "chief"],
  planner: ["math", "strategist", "quant", "architect", "modeler"],
  implementer: ["executor", "operator", "builder", "engineer", "coder", "worker"],
  researcher: ["scout", "analyst", "investigator", "factfinder", "intel"],
  reviewer: ["auditor", "veto", "critic", "inspector", "qa"],
};

export function hasRole(role, wanted) {
  const w = String(wanted || "").trim().toLowerCase();
  if (!w) return false;
  const tokens = roleSet(role);
  if (tokens.includes(w)) return true;
  return (ROLE_ALIASES[w] || []).some((a) => tokens.includes(a));
}

// Lenient confidence parsing for task_done (jcode-style): word rungs, negations,
// and 0-1 / 0-10 / 0-100 scores. Returns "low" | "medium" | "high" | null.
export function parseConfidence(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return null;
  const negated = ["not confident", "not certain", "not sure", "unsure", "uncertain", "no confidence", "no idea", "guessing", "not verified"];
  if (negated.some((n) => v.includes(n))) return "low";
  if (v.includes("low")) return "low";
  if (v.includes("med") || v.includes("moderate")) return "medium";
  if (v.includes("high") || v.includes("confident") || v.includes("certain")) return "high";
  const m = v.match(/(\d+(?:\.\d+)?)/);
  if (m) {
    const n = parseFloat(m[1]);
    if (v.includes("%") || n > 10) {
      if (n < 50) return "low";
      if (n < 80) return "medium";
      return "high";
    }
    if (n <= 1) {
      if (n < 0.5) return "low";
      if (n < 0.8) return "medium";
      return "high";
    }
    if (n < 5) return "low";
    if (n < 8) return "medium";
    return "high";
  }
  return null;
}

export async function joinMember(root, team, { id, name, role, rejoin = false }) {
  const meta = await loadTeam(root, team);
  if (!meta) {
    return {
      ok: false,
      error: `Team "${team}" does not exist. Create it first (team create / /team create).`,
    };
  }
  name = sanitizeName(name) || `agent-${String(id).slice(0, 6)}`;
  role = sanitizeRole(role);
  return withTeamLock(root, team, async () => {
    const members = await loadMembers(root, team);
    let replaced = false;
    for (const [sid, m] of Object.entries(members)) {
      if (m && m.name === name && sid !== id) {
        // A name is only "taken" by a LIVE member (recent heartbeat, not
        // offline). Dead sessions (crashed / power loss / closed) release
        // their name so the team can come back without manual cleanup.
        const dead = m.status === "offline" || Date.now() - (m.lastSeen || 0) > STALE_MEMBER_MS;
        if (!dead) {
          return {
            ok: false,
            error: `Name "${name}" is held by a LIVE member (${sid.slice(0, 8)}…). If that session is dead, it frees the name automatically once its heartbeat goes stale (~2 min), or a coordinator can run /team prune --hours 0 to reap it now. Otherwise pick a unique name with --name.`,
          };
        }
        delete members[sid]; // reclaim the name from the dead session
        replaced = true;
      }
    }
    members[id] = {
      name,
      role,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      status: "idle",
    };
    await writeJsonAtomic(path.join(teamDir(root, team), "members.json"), { members });
    await upsertPresetMember(root, team, name, role);
    await appendTeamLog(
      root,
      team,
      {
        ts: Date.now(),
        event: replaced ? "member_rejoined" : "member_joined",
        id,
        name,
        role,
      },
    );
    return { ok: true, member: { id, name, role } };
  });
}

// Coordinator action: remove a specific member by name (from the roster and
// the preset). Frees their name; their own sessions may rejoin later (that is
// a roster change the coordinator sees). Notifies the kicked member.
// ---- self-ping timers: 'wake me at <time>' for one member -------------------
// Persisted in the team dir so a restart re-arms them: a timer due while the
// member was offline fires on the next session start.

function timersFile(root, team) {
  return path.join(teamDir(root, team), "timers.json");
}

async function readTimers(root, team) {
  try {
    return JSON.parse(await fs.promises.readFile(timersFile(root, team), "utf8")) || {};
  } catch {
    return {};
  }
}

async function writeTimers(root, team, all) {
  await fs.promises.mkdir(teamDir(root, team), { recursive: true });
  await writeJsonAtomic(timersFile(root, team), all);
}

export async function setTimer(root, team, memberId, { minutes, at, body, tag }) {
  const now = Date.now();
  let dueAt = null;
  if (at) {
    const m = String(at).match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return { ok: false, error: `bad time "${at}" (use HH:MM)` };
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return { ok: false, error: `bad time "${at}" (HH:MM)` };
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    dueAt = d.getTime();
    if (dueAt <= now) dueAt += 24 * 60 * 60 * 1000; // next occurrence
  } else {
    const mins = Number(minutes ?? 30);
    if (!Number.isFinite(mins) || mins <= 0) return { ok: false, error: "minutes must be > 0" };
    dueAt = now + mins * 60 * 1000;
  }
  const all = await readTimers(root, team);
  const timers = (all[memberId] ||= []);
  const t = { id: `t_${Date.now()}_${randomUUID().slice(0, 4)}`, dueAt, body: String(body || "").slice(0, 500), createdAt: now, tag: tag || null };
  timers.push(t);
  timers.sort((a, b) => a.dueAt - b.dueAt);
  await writeTimers(root, team, all);
  await appendTeamLog(root, team, { ts: now, event: "timer_set", id: t.id, name: memberId, dueAt, body: t.body });
  return { ok: true, timer: t };
}

export async function listTimers(root, team, memberId) {
  const all = await readTimers(root, team);
  return (all[memberId] || []).slice();
}

export async function cancelTimer(root, team, memberId, id) {
  const all = await readTimers(root, team);
  const timers = all[memberId] || [];
  const idx = timers.findIndex((t) => t.id === id);
  if (idx < 0) return { ok: false, error: `no timer "${id}"` };
  timers.splice(idx, 1);
  await writeTimers(root, team, all);
  await appendTeamLog(root, team, { ts: Date.now(), event: "timer_cancel", id, name: memberId });
  return { ok: true };
}

// Atomically claim timers due at/before `now` (removes them so a restart
// cannot double-fire). Returns the claimed timers.
export async function claimDueTimers(root, team, memberId, now = Date.now()) {
  const all = await readTimers(root, team);
  const timers = all[memberId] || [];
  const due = timers.filter((t) => t.dueAt <= now);
  if (!due.length) return [];
  all[memberId] = timers.filter((t) => t.dueAt > now);
  await writeTimers(root, team, all);
  return due;
}

// ---- web search via local SearXNG ----------------------------------------
// Works for every team out of the box: resolves the SearXNG base URL from
// (per-team team.json searchUrl) -> env (PI_TEAM_SEARXNG_URL, SEARXNG_URL,
// JCODE_SEARXNG_URL) -> default http://127.0.0.1:8888.

export function resolveSearchUrl(env = process.env, teamMeta = null) {
  const fromTeam = teamMeta?.searchUrl?.trim();
  if (fromTeam) return fromTeam.replace(/\/$/, "");
  for (const k of ["PI_TEAM_SEARXNG_URL", "SEARXNG_URL", "JCODE_SEARXNG_URL"]) {
    const v = env[k]?.trim();
    if (v) return v.replace(/\/$/, "");
  }
  return "http://127.0.0.1:8888";
}

export async function searchWeb(query, { count = 6, categories, env = process.env, teamMeta = null, timeoutMs = 20_000 } = {}) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "query required" };
  const base = resolveSearchUrl(env, teamMeta);
  const params = new URLSearchParams({ q, format: "json", safesearch: "0" });
  if (categories) params.set("categories", String(categories));
  try {
    const res = await fetch(`${base}/search?${params}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, error: `SearXNG ${base} returned HTTP ${res.status}` };
    const data = await res.json();
    const results = (data.results || [])
      .filter((r) => r && r.url)
      .slice(0, Math.max(1, Math.min(10, Number(count) || 6)))
      .map((r) => ({
        title: String(r.title || "").slice(0, 200),
        url: String(r.url),
        snippet: String(r.content || "").replace(/\s+/g, " ").trim().slice(0, 300),
        engine: Array.isArray(r.engines) ? r.engines.join(",") : String(r.engine || ""),
      }));
    return { ok: true, base, count: results.length, results };
  } catch (e) {
    return { ok: false, error: `search failed (${base}): ${e?.message || e}` };
  }
}

// ---- checkin records: non-blocking status checks -------------------------
// The coordinator sends wake DMs and ends its turn; replies auto-wake it and
// the watcher records progress here so the coordinator never has to block or
// poll. One pending checkin per coordinator (latest replaces).

function checkinsFile(root, team) {
  return path.join(teamDir(root, team), "checkins.json");
}

export async function setCheckin(root, team, byId, { question, targets }) {
  const dir = teamDir(root, team);
  await fs.promises.mkdir(dir, { recursive: true });
  let all = {};
  try {
    all = JSON.parse(await fs.promises.readFile(checkinsFile(root, team), "utf8"));
  } catch { /* first checkin */ }
  all[byId] = { by: byId, question, targets, sentAt: Date.now(), replied: [] };
  await writeJsonAtomic(checkinsFile(root, team), all);
  return all[byId];
}

export async function recordCheckinReplies(root, team, byId, senders) {
  const file = checkinsFile(root, team);
  let all = {};
  try {
    all = JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch { return null; }
  const rec = all[byId];
  if (!rec || !rec.targets?.length) return null;
  let changed = false;
  for (const name of senders) {
    if (rec.targets.includes(name) && !rec.replied.includes(name)) {
      rec.replied.push(name);
      changed = true;
    }
  }
  if (changed) await writeJsonAtomic(file, all);
  return rec;
}

export async function getCheckin(root, team, byId) {
  try {
    const all = JSON.parse(await fs.promises.readFile(checkinsFile(root, team), "utf8"));
    return all[byId] || null;
  } catch { return null; }
}

export async function clearCheckin(root, team, byId) {
  const file = checkinsFile(root, team);
  try {
    const all = JSON.parse(await fs.promises.readFile(file, "utf8"));
    delete all[byId];
    await writeJsonAtomic(file, all);
  } catch { /* nothing to clear */ }
}

export async function kickMember(root, team, targetName, { byId, byName, reason } = {}) {
  const meta = await loadTeam(root, team);
  if (!meta) return { ok: false, error: `Team "${team}" does not exist.` };
  return withTeamLock(root, team, async () => {
    const members = await loadMembers(root, team);
    const hit = Object.entries(members).find(([, m]) => m && m.name === targetName);
    if (!hit) return { ok: false, error: `no member named "${targetName}" in team "${team}"` };
    const [sid, member] = hit;
    delete members[sid];
    await writeJsonAtomic(path.join(teamDir(root, team), "members.json"), { members });
    await removePresetMember(root, team, member.name);
    await appendTeamLog(root, team, {
      ts: Date.now(),
      event: "member_kicked",
      id: sid,
      name: member.name,
      by: byName || byId || "coordinator",
      reason: reason || null,
    });
    // Notify the kicked member's process, if it is still reachable.
    await sendMessage(root, team, {
      type: "system",
      from: byId || "coordinator",
      fromName: byName || "coordinator",
      fromRole: "coordinator",
      to: member.name,
      subject: "you were removed from the team",
      body: `You were removed from team "${team}" by ${byName || "the coordinator"}${reason ? `: ${reason}` : ""}. Your session will no longer be part of the roster.`,
      targets: [sid],
    }).catch(() => {});
    return { ok: true, member: { id: sid, name: member.name, role: member.role } };
  });
}

export async function leaveMember(root, team, id) {
  return withTeamLock(root, team, async () => {
    const members = await loadMembers(root, team);
    const m = members[id];
    delete members[id];
    await writeJsonAtomic(path.join(teamDir(root, team), "members.json"), { members });
    if (m) {
      await removePresetMember(root, team, m.name);
      await appendTeamLog(root, team, { ts: Date.now(), event: "member_left", id, name: m.name });
    }
    return { ok: true };
  });
}

export async function touchMember(root, team, id, { status } = {}) {
  return withTeamLock(root, team, async () => {
    const members = await loadMembers(root, team);
    const m = members[id];
    if (!m) return { ok: false };
    m.lastSeen = Date.now();
    if (typeof status === "string") m.status = String(status).slice(0, 80);
    await writeJsonAtomic(path.join(teamDir(root, team), "members.json"), { members });
    return { ok: true };
  });
}

// Fully synchronous single-field status write for shutdown paths: no awaits
// between lock acquisition and release, so the process cannot be killed with
// the lock held (which would orphan the lock dir and block other members for
// the stale-lock window). Gives up after ~2s if the lock is busy rather than
// failing the caller. Best-effort: returns false on any error.
export function setMemberStatusSync(root, team, id, status) {
  const dir = teamDir(root, team);
  const lock = path.join(dir, ".lock");
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      if (Date.now() - start > 2000) return false;
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(lock, { recursive: true, force: true });
        }
      } catch {
        /* lock disappeared */
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    }
  }
  try {
    const file = path.join(dir, "members.json");
    let members = {};
    try {
      members = JSON.parse(fs.readFileSync(file, "utf8")).members || {};
    } catch {
      /* missing/corrupt: start empty */
    }
    const m = members[id];
    if (m) {
      m.status = String(status).slice(0, 80);
      m.lastSeen = Date.now();
    }
    const tmp = `${file}.tmp-sync-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ members }, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export async function setMemberRole(root, team, id, role) {
  return withTeamLock(root, team, async () => {
    const members = await loadMembers(root, team);
    const m = members[id];
    if (!m) return { ok: false, error: "not a member" };
    m.role = sanitizeRole(role);
    await writeJsonAtomic(path.join(teamDir(root, team), "members.json"), { members });
    await upsertPresetMember(root, team, m.name, m.role);
    await appendTeamLog(root, team, { ts: Date.now(), event: "role_changed", id, role: m.role });
    return { ok: true, member: m };
  });
}

export function rosterList(members, selfId) {
  return Object.entries(members)
    .filter(([, m]) => m && m.name)
    .map(([id, m]) => ({
      id,
      name: m.name,
      role: m.role || "agent",
      status: m.status || "idle",
      lastSeen: m.lastSeen || 0,
      self: id === selfId,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// Resolve a "to" address: a member name, or role:<role> for every member with
// that role (excluding the sender).
// Cross-team comm is LEAD-TO-LEAD: the sender must be a coordinator of their
// team (Hub/Boss/Lead aliases count) and every resolved target must be a
// coordinator of the target team. Boards/tasks stay per-team.
export function crossTeamCheck(senderRole, targetMembers, targetIds) {
  if (!hasRole(senderRole, "coordinator")) {
    return {
      ok: false,
      error:
        "cross-team comm is lead-only: you must be a coordinator (Hub/Boss/Lead) of your own team to DM another team. Ask your coordinator to relay.",
    };
  }
  const nonLeads = targetIds
    .map((id) => targetMembers[id])
    .filter((m) => m && !hasRole(m.role, "coordinator"))
    .map((m) => m.name);
  if (nonLeads.length) {
    return {
      ok: false,
      error: `cross-team comm is lead-to-lead: ${nonLeads.join(", ")} is not a coordinator of the target team. Talk to that team's coordinator instead.`,
    };
  }
  return { ok: true };
}

// Resolve a cross-team address "TeamName/MemberName" or "TeamName/role:role".
// Returns the resolved team + members + ids, or { error }.
export async function resolveCrossTarget(root, to) {
  const t = String(to || "").trim();
  if (!t.includes("/")) return null; // not a cross-team address
  const slash = t.indexOf("/");
  const teamName = t.slice(0, slash).trim();
  const memberPart = t.slice(slash + 1).trim();
  if (!teamName || !memberPart) return { error: `bad cross-team address "${to}" (use TeamName/MemberName or TeamName/role:role)` };
  const team = await resolveTeamName(root, teamName);
  if (!team) return { error: `unknown team "${teamName}" in cross-team address` };
  const members = await loadMembers(root, team);
  const selfId = "__cross__";
  const res = resolveTargets(members, selfId, memberPart);
  if (res.error) return { error: `${res.error} (in team "${team}")` };
  const names = res.ids.map((id) => members[id]?.name).filter(Boolean);
  return { team, members, ids: res.ids, names };
}

export function resolveTargets(members, selfId, to) {
  if (!to || !String(to).trim()) {
    return { ids: [], error: "no target given (use a member name or role:<role>)" };
  }
  const t = String(to).trim();
  const roleMatch = t.match(/^role:(.+)$/i);
  if (roleMatch) {
    const role = roleMatch[1].trim();
    const ids = Object.entries(members)
      .filter(([id, m]) => m && hasRole(m.role, role) && id !== selfId)
      .map(([id]) => id);
    if (!ids.length) {
      return { ids: [], error: `no other members with role "${role}"` };
    }
    return { ids };
  }
  const tl = t.toLowerCase();
  const hits = Object.entries(members).filter(([id, m]) => m && String(m.name || "").toLowerCase() === tl && id !== selfId);
  if (!hits.length) {
    const names = rosterList(members, selfId)
      .map((m) => m.name)
      .join(", ");
    return {
      ids: [],
      error: `unknown member "${t}" (use a member name or role:<role>). Roster: ${names || "(empty)"}`,
    };
  }
  return { ids: hits.map(([id]) => id) };
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

export async function sendMessage(root, team, msg, opts = {}) {
  const meta = await loadTeam(root, team);
  if (!meta) return { ok: false, error: `Team "${team}" does not exist.` };
  const targets = msg.targets || [];
  if (!targets.length) return { ok: false, error: "no recipients" };
  const now = Date.now();
  // Cross-team delivery: `team` is the DELIVERY team; logTeams is where the
  // audit trail lands (both sides for cross-team, so the reply rule works
  // across the boundary).
  const members = opts.members || (await loadMembers(root, team).catch(() => ({})));
  const logTeams = opts.logTeams?.length ? opts.logTeams : [team];
  // Airtight reply rule: a DM back to someone who recently messaged you is a
  // reply, and replies ALWAYS wake the recipient — no model cooperation needed.
  // Detected statelessly from the audit log (survives restarts): target's
  // message to me within the window, or a broadcast from them, or an explicit
  // replyTo.
  let isReply = false;
  const singleTargetName =
    targets.length === 1 ? members[targets[0]]?.name || null : null;
  if (!String(msg.to || "").toLowerCase().startsWith("role:") && singleTargetName) {
    const windowMs = 60 * 60 * 1000;
    for (const lt of logTeams) {
      const tail = await readLogTail(root, lt);
      if (
        tail.some(
          (e) =>
            e.event === "message" &&
            e.from === singleTargetName &&
            (e.to === msg.fromName || e.to === "everyone") &&
            now - (e.ts || 0) < windowMs,
        )
      ) {
        isReply = true;
        break;
      }
    }
  }
  if (msg.replyTo) isReply = true;
  const wake = msg.wake === true || isReply;
  const envelope = {
    id: `msg_${Date.now()}_${randomUUID().slice(0, 8)}`,
    type: msg.type || "dm", // dm | broadcast | task | report | system
    ts: now,
    from: msg.from,
    fromName: msg.fromName,
    fromRole: msg.fromRole,
    fromTeam: msg.fromTeam || null,
    to: msg.to,
    subject: msg.subject || null,
    body: msg.body || "",
    priority: msg.priority || "normal",
    wake,
    isReply,
    replyTo: msg.replyTo || null,
  };
  let delivered = 0;
  for (const tid of targets) {
    const dir = inboxDir(root, team, tid);
    await fsp.mkdir(dir, { recursive: true });
    await writeJsonAtomic(
      path.join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.json`),
      envelope,
    );
    delivered++;
  }
  for (const lt of logTeams) {
    await appendTeamLog(root, lt, {
      ts: envelope.ts,
      event: "message",
      id: envelope.id,
      type: envelope.type,
      from: envelope.fromName,
      fromTeam: envelope.fromTeam || null,
      to: envelope.to,
      subject: envelope.subject,
      priority: envelope.priority,
      wake: envelope.wake,
    });
  }
  // Liveness of targets, so senders can warn about queued-but-unread messages.
  const offlineTargets = targets
    .map((tid) => ({ id: tid, name: members[tid]?.name || tid.slice(0, 8) }))
    .filter((t) => isMemberDead(members[t.id], now));
  return { ok: true, delivered, id: envelope.id, wake: envelope.wake, isReply: envelope.isReply, offlineTargets };
}

// Read and REMOVE all pending messages for a member. Read == consumed, so a
// message is never injected twice (once drained by one path, the others find
// an empty inbox).
export async function drainInbox(root, team, memberId) {
  const dir = inboxDir(root, team, memberId);
  let files = [];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.sort()) {
    if (!f.endsWith(".json") || f.includes(".tmp-")) continue;
    const full = path.join(dir, f);
    try {
      const msg = JSON.parse(await fsp.readFile(full, "utf8"));
      await fsp.unlink(full);
      out.push(msg);
    } catch {
      /* skip or leave broken files */
    }
  }
  return out;
}

export async function pendingCount(root, team, memberId) {
  const dir = inboxDir(root, team, memberId);
  try {
    const files = await fsp.readdir(dir);
    return files.filter((f) => f.endsWith(".json") && !f.includes(".tmp-")).length;
  } catch {
    return 0;
  }
}

// True when any pending message is marked wake (the sender asked for an
// immediate response even while idle).
export async function hasWakePending(root, team, memberId) {
  const dir = inboxDir(root, team, memberId);
  let files = [];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return false;
  }
  for (const f of files) {
    if (!f.endsWith(".json") || f.includes(".tmp-")) continue;
    try {
      const msg = JSON.parse(await fsp.readFile(path.join(dir, f), "utf8"));
      if (msg.wake === true) return true;
    } catch {
      /* skip broken files */
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shared board (markdown artifacts)
// ---------------------------------------------------------------------------

export async function readBoard(root, team, topic, storeDir) {
  const bdir = boardDir(root, team, storeDir);
  if (topic) {
    try {
      return {
        ok: true,
        topic,
        content: await fsp.readFile(path.join(bdir, `${topic}.md`), "utf8"),
      };
    } catch {
      return { ok: false, error: `no board topic "${topic}"` };
    }
  }
  try {
    const files = (await fsp.readdir(bdir)).filter((f) => f.endsWith(".md")).sort();
    return { ok: true, topics: files.map((f) => f.slice(0, -3)) };
  } catch {
    return { ok: true, topics: [] };
  }
}

export async function writeBoard(root, team, topic, content, storeDir) {
  if (!BOARD_TOPIC_RE.test(topic || "")) {
    return { ok: false, error: `invalid board topic "${topic}" (letters/digits/._- max 64)` };
  }
  const file = path.join(boardDir(root, team, storeDir), `${topic}.md`);
  await writeTextAtomic(file, content);
  await appendLine(
    path.join(teamDir(root, team), "log.jsonl"),
    JSON.stringify({ ts: Date.now(), event: "board_write", topic }),
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

// Tail-read the audit log efficiently (last `lines` entries within the last
// `maxBytes`), for cheap reply detection on every send.
export async function readLogTail(root, team, { lines = 200, maxBytes = 256 * 1024 } = {}) {
  const file = path.join(teamDir(root, team), "log.jsonl");
  try {
    const st = await fsp.stat(file);
    const start = Math.max(0, st.size - maxBytes);
    const fh = await fsp.open(file, "r");
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    await fh.close();
    const slice = buf.toString("utf8").split("\n").filter(Boolean).slice(-lines);
    return slice
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function readLog(root, team, limit = 100) {
  try {
    const text = await fsp.readFile(path.join(teamDir(root, team), "log.jsonl"), "utf8");
    const lines = text.split("\n").filter(Boolean).slice(-limit);
    return lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Task board (structured tasks, light "typed artifact" discipline)
// ---------------------------------------------------------------------------

export const TASK_STATUSES = ["queued", "running", "blocked", "failed", "done"];

// Coordinator action: wipe the board so the team can pivot to a new project.
// Tasks are ARCHIVED first (never destroyed): archive/tasks-<timestamp>.json.
// Optionally also clears board topics (clearTopics). Audit-logged.
export async function clearBoard(root, team, { clearTopics = false } = {}, storeDir) {
  return withTeamLock(root, team, async () => {
    const dir = storeDir || teamDir(root, team);
    const tasks = await loadTasks(root, team, storeDir);
    const archiveDir = path.join(dir, "archive");
    await fsp.mkdir(archiveDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archive = path.join(archiveDir, `tasks-${stamp}.json`);
    await writeJsonAtomic(archive, { archivedAt: Date.now(), team, tasks });
    await writeJsonAtomic(path.join(dir, "tasks.json"), { tasks: [] });
    let topicsCleared = 0;
    if (clearTopics) {
      const boardDir = path.join(dir, "board");
      try {
        const entries = await fsp.readdir(boardDir);
        for (const e of entries) {
          if (e.endsWith(".md")) {
            await fsp.unlink(path.join(boardDir, e));
            topicsCleared++;
          }
        }
      } catch { /* no board dir */ }
    }
    await appendTeamLog(root, team, {
      ts: Date.now(),
      event: "board_cleared",
      archivedTasks: tasks.length,
      doneTasks: tasks.filter((t) => t.status === "done").length,
      archive,
      clearTopics,
    });
    return {
      ok: true,
      archived: tasks.length,
      done: tasks.filter((t) => t.status === "done").length,
      topicsCleared,
      archive,
    };
  });
}

export async function loadTasks(root, team, storeDir) {
  const data = await readJson(path.join(storeDir || teamDir(root, team), "tasks.json"), {
    tasks: [],
  });
  return Array.isArray(data.tasks) ? data.tasks : [];
}

// task shape:
// { id, title, body, assignee (name | role:<role> | null), status, priority,
//   kind ("work"|"review"), reviewOf (task id, when kind=review),
//   criteria[], dependsOn[], createdBy, createdByName, createdAt, assignedAt,
//   startedAt, doneAt, evidence, blockedReason, failReason, updatedAt }

export async function createTask(root, team, spec, storeDir) {
  if (!(await teamExists(root, team))) {
    return { ok: false, error: `Team "${team}" does not exist.` };
  }
  const title = String(spec.title || "").trim();
  if (!title) return { ok: false, error: "task title (subject) required" };
  const id =
    String(spec.id || "").trim() || `t_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}`;
  const assignee = spec.assignee ? String(spec.assignee).trim() : null;
  if (assignee && !/^[A-Za-z0-9._\- ]{1,40}$/.test(assignee) && !assignee.startsWith("role:")) {
    return { ok: false, error: "assignee must be a member name or role:<role>" };
  }
  const kind = spec.kind === "review" ? "review" : "work";
  const reviewOf = kind === "review" ? String(spec.reviewOf || "").trim() || null : null;
  if (kind === "review" && !reviewOf) {
    return { ok: false, error: "a review task requires review_of (the task id being reviewed)" };
  }
  return withTeamLock(root, team, async () => {
    const tasks = await loadTasks(root, team, storeDir);
    if (tasks.some((t) => t.id === id)) {
      return { ok: false, error: `task id "${id}" already exists` };
    }
    const warnings = [];
    if (kind === "review" && reviewOf) {
      const reviewed = tasks.find((t) => t.id === reviewOf);
      if (!reviewed) {
        return { ok: false, error: `review task references unknown task "${reviewOf}"` };
      }
      if (reviewed.assignee && assignee && reviewed.assignee === assignee) {
        warnings.push(
          `reviewer assignment matches the reviewed task's assignee (${assignee}) — use a different role/name for an independent review`,
        );
      }
      if (
        reviewed.assignee?.startsWith("role:") &&
        assignee?.startsWith("role:") &&
        roleSet(reviewed.assignee.slice(5)).some((r) => roleSet(assignee.slice(5)).includes(r))
      ) {
        warnings.push(
          `reviewer role overlaps the reviewed task's assignee roles (${assignee}) — use a different role for an independent review`,
        );
      }
    }
    const task = {
      id,
      title,
      body: String(spec.body || "").trim() || null,
      assignee,
      status: "queued",
      priority: spec.priority === "high" ? "high" : "normal",
      kind,
      reviewOf,
      criteria: (spec.criteria || []).map((c) => String(c).trim()).filter(Boolean),
      dependsOn: (spec.dependsOn || []).map(String).filter(Boolean),
      createdBy: spec.createdBy || null,
      createdByName: spec.createdByName || null,
      createdAt: Date.now(),
      assignedAt: null,
      startedAt: null,
      doneAt: null,
      evidence: null,
      confidence: null,
      blockedReason: null,
      failReason: null,
      updatedAt: Date.now(),
    };
    tasks.push(task);
    await writeJsonAtomic(path.join(storeDir || teamDir(root, team), "tasks.json"), { tasks });
    await appendTeamLog(root, team, {
      ts: Date.now(),
      event: "task_created",
      task: id,
      title,
      assignee,
      kind,
      reviewOf,
    });
    // Atomic with the create: notify assignees so the task lands in their inbox.
    let notified = 0;
    if (task.assignee) {
      const members = await loadMembers(root, team);
      const selfId = task.createdBy || "";
      const tgt = resolveTargets(members, selfId, task.assignee);
      if (!tgt.error && tgt.ids.length) {
        const fromRole = selfId ? members[selfId]?.role || "agent" : "agent";
        const criteriaText = task.criteria.length
          ? `\nAcceptance criteria:\n- ${task.criteria.join("\n- ")}`
          : "";
        const body =
          kind === "review"
            ? `REVIEW task for ${reviewOf}: ${task.title}\n\n${task.body || ""}\n\n` +
              `Read the evidence on ${reviewOf} (team task_show task_id=${reviewOf}), then pass with team task_done task_id=${task.id} --evidence "<review findings>", or bounce it back with team task_fail task_id=${task.id} --body "<issues>".`
            : `Task: ${task.title}\n\n${task.body || ""}${criteriaText}\n\n` +
              `Complete it with: team task_done task_id=${task.id} --evidence "<what you changed, file refs, validation>"`;
        await sendMessage(root, team, {
          type: "task",
          from: task.createdBy,
          fromName: task.createdByName || task.createdBy,
          fromRole,
          to: task.assignee,
          subject: kind === "review" ? `assigned: review of ${reviewOf}` : `assigned: ${task.title}`,
          body,
          priority: "high",
          wake: true,
          targets: tgt.ids,
        });
        notified = tgt.ids.length;
      }
    }
    return { ok: true, task, notified, warnings };
  });
}

// Validated task transition. Permission model (light, social):
//   - the assignee (by name), anyone with the assigned role, or a coordinator
//     may change status; unassigned tasks are claimable by anyone;
//   - reassignment requires the creator or a coordinator.
// Enforcement (the "typed artifact" bit):
//   - a task cannot flip to done without evidence;
//   - done is HARD-blocked on unfinished dependencies unless the actor passes
//     dep_override with a reason (jcode's "parent cannot close with open gaps",
//     with an escape hatch);
//   - failing a REVIEW task bounces its reviewed task back to running and
//     notifies the implementer (the critique gate, made concrete).
// Notifications are atomic with transitions: done -> creator, blocked/failed
// -> coordinator (fallback creator), review-fail -> reviewed task's assignee.
export async function updateTask(root, team, taskId, patch, actor, storeDir) {
  const meta = await loadTeam(root, team);
  if (!meta) return { ok: false, error: `Team "${team}" does not exist.` };
  return withTeamLock(root, team, async () => {
    const tasks = await loadTasks(root, team, storeDir);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, error: `unknown task "${taskId}"` };
    const warnings = [];
    let bouncedTaskId = null;
    let acceptedTaskId = null;

    if (patch.status !== undefined && patch.status !== task.status) {
      const to = String(patch.status);
      if (!TASK_STATUSES.includes(to)) {
        return { ok: false, error: `invalid task status "${to}" (queued|running|blocked|failed|done)` };
      }
      const isAssignee = task.assignee
        ? task.assignee.startsWith("role:")
          ? hasRole(actor.role, task.assignee.slice(5))
          : actor.name === task.assignee
        : true; // unassigned: claimable by anyone
      const canManage = isAssignee || hasRole(actor.role, "coordinator");
      if (!canManage) {
        return {
          ok: false,
          error: `only the assignee (${task.assignee || "unassigned (claimable)"}) or a coordinator may set status to ${to}`,
        };
      }
      if (to === "done") {
        const evidence = String(patch.evidence || "").trim();
        if (!evidence) {
          return {
            ok: false,
            error:
              "evidence is required to complete a task: describe what changed (with file refs), and what validation you ran. A bare 'done' is rejected.",
          };
        }
        const unfinished = [];
        for (const did of task.dependsOn) {
          const dep = tasks.find((x) => x.id === did);
          if (!dep || dep.status !== "done") unfinished.push(did);
        }
        if (unfinished.length && !String(patch.depOverride || "").trim()) {
          return {
            ok: false,
            error: `task ${taskId} has unfinished dependencies: ${unfinished.join(", ")}. Complete them first, or pass dep_override with a reason to accept the task as-is.`,
          };
        }
        if (unfinished.length) {
          warnings.push(...unfinished.map((d) => `${d} (accepted via dep_override)`));
        }
        task.evidence = evidence;
        task.doneAt = Date.now();
        task.confidence = parseConfidence(patch.confidence);
      }
      // A passing REVIEW task accepts the reviewed work (closes the loop with
      // the bounce: fail -> running, pass -> done).
      if (to === "done" && task.kind === "review" && task.reviewOf) {
        const reviewed = tasks.find((x) => x.id === task.reviewOf);
        if (reviewed && reviewed.status === "running") {
          reviewed.status = "done";
          reviewed.doneAt = Date.now();
          reviewed.evidence =
            reviewed.evidence ||
            `Accepted by review task ${task.id} (${actor.name}). Review evidence: ${task.evidence}`;
          reviewed.updatedAt = Date.now();
          acceptedTaskId = reviewed.id;
          await appendTeamLog(root, team, {
            ts: Date.now(),
            event: "task_accepted",
            task: reviewed.id,
            by_review: taskId,
          });
        }
      }
      if (to === "running") {
        for (const did of task.dependsOn) {
          const dep = tasks.find((x) => x.id === did);
          if (!dep || dep.status !== "done") warnings.push(did);
        }
        task.startedAt = Date.now();
      }
      if (to === "blocked") task.blockedReason = String(patch.reason || "").trim() || null;
      if (to === "failed") {
        task.failReason = String(patch.reason || "").trim() || null;
        // A failed REVIEW task bounces the reviewed work back to running:
        // the implementer must fix and re-complete (the critique gate).
        if (task.kind === "review" && task.reviewOf) {
          const reviewed = tasks.find((x) => x.id === task.reviewOf);
          if (reviewed && reviewed.status === "done") {
            reviewed.status = "running";
            reviewed.startedAt = Date.now();
            reviewed.doneAt = null;
            reviewed.evidence = null;
            reviewed.updatedAt = Date.now();
            bouncedTaskId = reviewed.id;
            await appendTeamLog(root, team, {
              ts: Date.now(),
              event: "task_bounced",
              task: reviewed.id,
              by_review: taskId,
              reason: task.failReason || "",
            });
          }
        }
      }
      if (to === "queued") {
        task.startedAt = null;
        task.doneAt = null;
        task.evidence = null;
        task.blockedReason = null;
        task.failReason = null;
      }
      task.status = to;
      task.updatedAt = Date.now();
      await appendTeamLog(root, team, {
        ts: Date.now(),
        event: "task_status",
        task: taskId,
        status: to,
        by: actor.name,
      });
    }

    // Atomic notifications for the transition.
    let notified = 0;
    const members = await loadMembers(root, team);

    if (task.status === "done" && task.createdByName) {
      const tgt = resolveTargets(members, actor.id, task.createdByName);
      if (!tgt.error && tgt.ids.length) {
        await sendMessage(root, team, {
          type: "task_done",
          from: actor.id,
          fromName: actor.name,
          fromRole: actor.role,
          to: task.createdByName,
          subject: `task done: ${task.title}`,
          body: task.evidence || "",
          wake: true,
          targets: tgt.ids,
        });
        notified += tgt.ids.length;
      }
    }

    if (task.status === "blocked" || task.status === "failed") {
      // Escalate to the coordinator; fall back to the creator.
      let targets = [];
      const coord = resolveTargets(members, actor.id, "role:coordinator");
      if (!coord.error) targets = coord.ids;
      if (!targets.length && task.createdByName) {
        const creator = resolveTargets(members, actor.id, task.createdByName);
        if (!creator.error) targets = creator.ids;
      }
      if (targets.length) {
        const type = task.status === "blocked" ? "task_blocked" : "task_failed";
        await sendMessage(root, team, {
          type,
          from: actor.id,
          fromName: actor.name,
          fromRole: actor.role,
          to: "coordinator",
          subject: `task ${task.status}: ${task.title}`,
          body: task.status === "blocked" ? task.blockedReason || "" : task.failReason || "",
          wake: true,
          targets,
        });
        notified += targets.length;
      }
    }

    if (bouncedTaskId) {
      const bounced = tasks.find((x) => x.id === bouncedTaskId);
      if (bounced && bounced.assignee) {
        const tgt = resolveTargets(members, actor.id, bounced.assignee);
        if (!tgt.error && tgt.ids.length) {
          await sendMessage(root, team, {
            type: "task_bounced",
            from: actor.id,
            fromName: actor.name,
            fromRole: actor.role,
            to: bounced.assignee,
            subject: `review failed: ${bounced.title}`,
            body:
              `Review of task ${bounced.id} failed by ${actor.name}: ${task.failReason || "no reason given"}\n` +
              `Please fix the issues and re-complete with task_done --evidence.`,
            priority: "high",
            wake: true,
            targets: tgt.ids,
          });
          notified += tgt.ids.length;
        }
      }
    }

    if (acceptedTaskId) {
      const accepted = tasks.find((x) => x.id === acceptedTaskId);
      if (accepted?.createdByName) {
        const tgt = resolveTargets(members, actor.id, accepted.createdByName);
        if (!tgt.error && tgt.ids.length) {
          await sendMessage(root, team, {
            type: "task_done",
            from: actor.id,
            fromName: actor.name,
            fromRole: actor.role,
            to: accepted.createdByName,
            subject: `task accepted: ${accepted.title}`,
            body: accepted.evidence || "",
            targets: tgt.ids,
          });
          notified += tgt.ids.length;
        }
      }
    }

    if (patch.assignee !== undefined) {
      const to = String(patch.assignee).trim();
      if (!to) return { ok: false, error: "assignee cannot be empty" };
      const isCreator = task.createdBy === actor.id;
      if (!hasRole(actor.role, "coordinator") && !isCreator) {
        return { ok: false, error: "only the task creator or a coordinator may reassign" };
      }
      task.assignee = to;
      task.assignedAt = Date.now();
      task.updatedAt = Date.now();
    }

    // Low-confidence completion: escalate to the coordinator and auto-create a
    // research follow-up task (assigned to the researcher, else the
    // coordinator) so uncertainty becomes structured work, not a footnote.
    // Created inline (not via createTask) to stay inside this lock.
    let lowConfidence = false;
    let researchTaskId = null;
    if (task.status === "done" && task.confidence === "low") {
      lowConfidence = true;
      const researchId = `t_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}`;
      const researchAssignee = members && Object.values(members).some((m) => m && hasRole(m.role, "researcher"))
        ? "role:researcher"
        : members && Object.values(members).some((m) => m && hasRole(m.role, "coordinator"))
          ? "role:coordinator"
          : null;
      if (researchAssignee) {
        tasks.push({
          id: researchId,
          title: `research follow-up: ${task.title}`,
          body:
            `Task ${task.id} was completed with LOW confidence by ${actor.name}.\n` +
            `Evidence: ${task.evidence || ""}\n\n` +
            `Investigate the weak areas, verify the claims, and report findings back to ${actor.name} (and a tldr to the coordinator).`,
          assignee: researchAssignee,
          status: "queued",
          priority: "high",
          kind: "work",
          reviewOf: null,
          criteria: ["verify the low-confidence claims", "report findings to the requester + tldr to coordinator"],
          dependsOn: [taskId],
          createdBy: actor.id,
          createdByName: actor.name,
          createdAt: Date.now(),
          assignedAt: null,
          startedAt: null,
          doneAt: null,
          evidence: null,
          confidence: null,
          blockedReason: null,
          failReason: null,
          updatedAt: Date.now(),
        });
        researchTaskId = researchId;
        await appendTeamLog(root, team, {
          ts: Date.now(),
          event: "task_low_confidence",
          task: taskId,
          research_task: researchId,
          by: actor.name,
        });
        // Notify the assignee of the follow-up (same as a normal task create).
        const rtgt = resolveTargets(members, actor.id, researchAssignee);
        if (!rtgt.error && rtgt.ids.length) {
          await sendMessage(root, team, {
            type: "task",
            from: actor.id,
            fromName: actor.name,
            fromRole: actor.role,
            to: researchAssignee,
            subject: `assigned: research follow-up for ${taskId}`,
            body:
              `Research follow-up for task ${taskId} (completed with LOW confidence by ${actor.name}).\n` +
              `Evidence: ${task.evidence || ""}\n\n` +
              `Complete with: team task_done task_id=${researchId} --evidence "<findings + sources>", and DM the requester with the full report + a tldr to the coordinator.`,
            priority: "high",
            wake: true,
            targets: rtgt.ids,
          });
          notified += rtgt.ids.length;
        }
      }
      // Notify the coordinator (fallback: the creator).
      let targets = [];
      const coord = resolveTargets(members, actor.id, "role:coordinator");
      if (!coord.error) targets = coord.ids;
      if (!targets.length && task.createdByName) {
        const creator = resolveTargets(members, actor.id, task.createdByName);
        if (!creator.error) targets = creator.ids;
      }
      if (targets.length) {
        await sendMessage(root, team, {
          type: "task_low_confidence",
          from: actor.id,
          fromName: actor.name,
          fromRole: actor.role,
          to: "coordinator",
          subject: `low confidence: ${task.title}`,
          body:
            `${actor.name} completed ${taskId} with LOW confidence.\nEvidence: ${task.evidence || ""}\n` +
            (researchTaskId ? `Auto-created research follow-up ${researchTaskId} (assigned to ${researchAssignee}).` : "No researcher/coordinator available to route a follow-up — review the evidence yourself."),
          wake: true,
          targets,
        });
        notified += targets.length;
      }
    }

    await writeJsonAtomic(path.join(storeDir || teamDir(root, team), "tasks.json"), { tasks });
    return { ok: true, task, warnings, notified, bouncedTaskId, acceptedTaskId, lowConfidence, researchTaskId };
  });
}

// ---------------------------------------------------------------------------
// Team hygiene: log rotation, temp-file sweep, dead-member pruning
// ---------------------------------------------------------------------------

export const TEAM_LOG_MAX_BYTES = 5 * 1024 * 1024;
const TEAM_LOG_KEEP = 3;
const SWEEP_TMP_OLDER_MS = 60 * 60 * 1000; // 1 hour
export const AUTO_PRUNE_OLDER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function rotateLogIfNeeded(root, team) {
  const file = path.join(teamDir(root, team), "log.jsonl");
  try {
    const st = await fsp.stat(file);
    if (st.size <= TEAM_LOG_MAX_BYTES) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fsp.rename(file, `${file}.${stamp}`).catch(() => {});
    const dir = path.dirname(file);
    const base = path.basename(file);
    const rotated = (await fsp.readdir(dir))
      .filter((f) => f.startsWith(base + "."))
      .sort();
    for (const old of rotated.slice(0, Math.max(0, rotated.length - TEAM_LOG_KEEP))) {
      await fsp.unlink(path.join(dir, old)).catch(() => {});
    }
  } catch {
    /* no log yet */
  }
}

// Append to the team audit log, rotating at TEAM_LOG_MAX_BYTES and keeping the
// last TEAM_LOG_KEEP rotated files so storage cannot grow unboundedly.
export async function appendTeamLog(root, team, entry) {
  const file = path.join(teamDir(root, team), "log.jsonl");
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await rotateLogIfNeeded(root, team);
  await fsp.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
}

// Remove members whose lastSeen is older than `olderThanMs`. Safe to run
// automatically (long default) or explicitly via /team prune.
export async function pruneMembers(root, team, { olderThanMs = 24 * 60 * 60 * 1000 } = {}) {
  const meta = await loadTeam(root, team);
  if (!meta) return { ok: false, error: `Team "${team}" does not exist.` };
  return withTeamLock(root, team, async () => {
    const members = await loadMembers(root, team);
    const now = Date.now();
    let removed = 0;
    for (const [sid, m] of Object.entries(members)) {
      if (m && now - (m.lastSeen || 0) > olderThanMs) {
        delete members[sid];
        removed++;
      }
    }
    if (removed) {
      await writeJsonAtomic(path.join(teamDir(root, team), "members.json"), { members });
      await appendTeamLog(root, team, { ts: now, event: "members_pruned", count: removed });
    }
    return { ok: true, removed };
  });
}

// Opportunistic hygiene sweep: delete stale .tmp-* files (killed writers),
// auto-prune members gone > 7 days, rotate an oversized log. Callers throttle
// this to ~1/hour.
export async function sweepTeam(root, team) {
  const base = teamDir(root, team);
  const dirs = [base, path.join(base, "board")];
  try {
    const inboxRoot = path.join(base, "inbox");
    const subs = await fsp.readdir(inboxRoot);
    dirs.push(...subs.map((s) => path.join(inboxRoot, s)));
  } catch {
    /* no inbox yet */
  }
  const now = Date.now();
  for (const dir of dirs) {
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.includes(".tmp-")) continue;
      const full = path.join(dir, n);
      try {
        const st = await fsp.stat(full);
        if (now - st.mtimeMs > SWEEP_TMP_OLDER_MS) await fsp.unlink(full);
      } catch {
        /* gone already */
      }
    }
  }
  await pruneMembers(root, team, { olderThanMs: AUTO_PRUNE_OLDER_MS }).catch(() => {});
  await rotateLogIfNeeded(root, team).catch(() => {});
  await sweepInbox(root, team).catch(() => {});
  await sweepCheckins(root, team).catch(() => {});
}

// Inbox hygiene: undelivered/stale message files older than a week are dead
// weight (a live watcher drains them; a dead member's inbox otherwise grows
// forever — Alpha once held 580KB of stale mail). Empty member dirs and
// empty stray dirs (e.g. a botched "wa1") are removed too.
export const INBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function sweepInbox(root, team) {
  const inboxRoot = path.join(teamDir(root, team), "inbox");
  let subs = [];
  try {
    subs = await fsp.readdir(inboxRoot);
  } catch {
    return { removed: 0 }; // no inbox yet
  }
  const now = Date.now();
  let removed = 0;
  for (const s of subs) {
    const sub = path.join(inboxRoot, s);
    let files = [];
    try {
      files = await fsp.readdir(sub);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const full = path.join(sub, f);
      try {
        const st = await fsp.stat(full);
        if (now - st.mtimeMs > INBOX_MAX_AGE_MS) {
          await fsp.unlink(full);
          removed++;
        }
      } catch {
        /* gone already */
      }
    }
    // drop the dir only once it is empty (never delete a member's live inbox)
    try {
      const left = await fsp.readdir(sub);
      if (left.length === 0) await fsp.rm(sub, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
  return { removed };
}

// Checkin records expire after a week — stale replies otherwise accumulate.
export const CHECKIN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function sweepCheckins(root, team) {
  const file = checkinsFile(root, team);
  let all = {};
  try {
    all = JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return 0;
  }
  const now = Date.now();
  const keep = {};
  let dropped = 0;
  for (const [id, rec] of Object.entries(all)) {
    if (rec && now - (rec.sentAt || 0) <= CHECKIN_MAX_AGE_MS) keep[id] = rec;
    else dropped++;
  }
  if (dropped) await writeJsonAtomic(file, keep);
  return dropped;
}

// pi's session store (~/.pi/agent/sessions/<cwd-slug>/<file>.jsonl): every
// spawned member window and test run writes one and NOTHING prunes them
// (measured 92 MB / 173 files). Keep the newest session per cwd-slug, drop
// the rest older than olderThanMs. apply=false = dry-run (count only).
export async function pruneSessions({ olderThanMs = 7 * 24 * 60 * 60 * 1000, apply = false, sessionsRoot = null } = {}) {
  const root =
    sessionsRoot || path.join(os.homedir(), ".pi", "agent", "sessions");
  let dirs = [];
  try {
    dirs = await fsp.readdir(root);
  } catch {
    return { ok: false, error: `no sessions dir at ${root}` };
  }
  const now = Date.now();
  let removable = 0;
  let removableBytes = 0;
  for (const d of dirs) {
    const full = path.join(root, d);
    let files = [];
    try {
      files = await fsp.readdir(full);
    } catch {
      continue;
    }
    const jsons = files.filter((f) => f.endsWith(".jsonl"));
    // the newest session in this dir always survives (max mtime — an
    // inverted comparison here would keep the OLDEST file instead; the
    // unit test for this caught that exact bug)
    let newest = null;
    let newestM = -Infinity;
    for (const f of jsons) {
      try {
        const st = await fsp.stat(path.join(full, f));
        if (st.mtimeMs > newestM) {
          newestM = st.mtimeMs;
          newest = f;
        }
      } catch {
        /* ignore */
      }
    }
    for (const f of jsons) {
      if (f === newest) continue;
      const fullPath = path.join(full, f);
      try {
        const st = await fsp.stat(fullPath);
        if (now - st.mtimeMs > olderThanMs) {
          removable++;
          removableBytes += st.size;
          if (apply) await fsp.unlink(fullPath);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { ok: true, removable, removableBytes, apply };
}

// Full-team hygiene across ALL teams + the pi session store. apply=false =
// dry-run report (nothing deleted).
export async function teamCleanup(root, { apply = false, olderThanMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  let teams = [];
  try {
    teams = (await fsp.readdir(root)).filter((t) => t !== "wa1");
  } catch {
    /* no teams root */
  }
  const report = { teams: [], sessions: null, dryRun: !apply };
  for (const t of teams) {
    const base = teamDir(root, t);
    const entry = { team: t, logBytes: 0, inboxBytes: 0, inboxFiles: 0, checkins: 0 };
    try {
      entry.logBytes = (await fsp.stat(path.join(base, "log.jsonl"))).size;
    } catch {
      /* no log */
    }
    try {
      const inboxRoot = path.join(base, "inbox");
      for (const s of await fsp.readdir(inboxRoot)) {
        const sub = path.join(inboxRoot, s);
        for (const f of await fsp.readdir(sub).catch(() => [])) {
          if (!f.endsWith(".json")) continue;
          const st = await fsp.stat(path.join(sub, f)).catch(() => null);
          if (st) {
            entry.inboxBytes += st.size;
            entry.inboxFiles++;
          }
        }
      }
    } catch {
      /* no inbox */
    }
    try {
      entry.checkins = Object.keys(JSON.parse(await fsp.readFile(path.join(base, "checkins.json"), "utf8"))).length;
    } catch {
      /* none */
    }
    if (apply) {
      await sweepTeam(root, t).catch(() => {});
    }
    report.teams.push(entry);
  }
  report.sessions = await pruneSessions({ olderThanMs, apply });
  return report;
}

// ---------------------------------------------------------------------------
// Team preset: the intended roster (name + role), independent of liveness.
// Auto-updated on join/leave/role-change; survives crashes (it is on disk);
// used by `team revive` / `/team revive` to spawn the whole team back.
// ---------------------------------------------------------------------------

// ---- team definition files (versioned in the repo for portability) --------
// teams/<Team>.json carries everything needed to recreate a team on another
// machine: preset members, briefing, settings (autoRespond/interject/
// searchUrl) and standing autoTimers.

export function teamDefPath(extensionRoot, team) {
  return path.join(extensionRoot || ".", "teams", `${team}.json`);
}

export async function exportTeam(root, team, outDir) {
  const meta = await loadTeam(root, team);
  if (!meta) return { ok: false, error: `Team "${team}" does not exist.` };
  const preset = await loadPreset(root, team);
  const briefing = await loadBrief(root, team).catch(() => null);
  const def = {
    name: team,
    version: 1,
    preset: (preset?.members || []).map((m) => ({ name: m.name, role: m.role })),
    briefing: briefing || null,
    settings: {
      autoRespond: meta.autoRespond,
      interject: meta.interject,
      searchUrl: meta.searchUrl || null,
      autoTimers: meta.autoTimers || [],
    },
  };
  const dir = outDir || teamDefPath(process.cwd());
  await fsp.mkdir(path.dirname(dir), { recursive: true });
  await writeJsonAtomic(dir, def);
  return { ok: true, file: dir, members: def.preset.length };
}

export async function importTeam(root, file) {
  let def;
  try {
    def = JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (e) {
    return { ok: false, error: `cannot read team definition "${file}": ${e?.message || e}` };
  }
  const name = String(def.name || "").trim();
  if (!name) return { ok: false, error: "team definition missing a name" };
  if (!(await teamExists(root, name))) {
    await createTeam(root, name, {});
  }
  const settings = def.settings || {};
  await setTeamSetting(root, name, {
    autoRespond: settings.autoRespond !== false,
    interject: settings.interject !== false,
    searchUrl: settings.searchUrl || undefined,
    autoTimers: Array.isArray(settings.autoTimers) ? settings.autoTimers : undefined,
  }).catch(() => {});
  if (Array.isArray(def.preset) && def.preset.length) {
    await savePreset(root, name, def.preset);
  }
  if (typeof def.briefing === "string" && def.briefing.trim()) {
    await saveBrief(root, name, def.briefing);
  }
  await appendTeamLog(root, name, { ts: Date.now(), event: "team_imported", from: file, preset: (def.preset || []).length });
  return { ok: true, name, members: (def.preset || []).length };
}

// WhatsApp bridge outbox: the dispatcher queues replies here; the bridge
// daemon (bridge/index.mjs) drains them and sends on WhatsApp. Lives outside
// the repo (default ~/.pi/wa-bridge) so credentials never touch git.
export async function queueWaReply(bridgeDir, { to, body, fromName, team, ts = Date.now() }) {
  const dir = path.join(bridgeDir, "outbox");
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${ts}-${randomUUID().slice(0, 6)}.json`);
  await writeJsonAtomic(file, { to, body, fromName, team, ts });
  return { ok: true, file };
}

export async function loadPreset(root, team) {
  const data = await readJson(path.join(teamDir(root, team), "preset.json"), null);
  return data && Array.isArray(data.members) ? data : null;
}

export async function savePreset(root, team, members) {
  const file = path.join(teamDir(root, team), "preset.json");
  await writeJsonAtomic(file, {
    name: team,
    savedAt: Date.now(),
    // Preserve stable member ids (e.g. dispatcher-main) so external bridges
    // (WhatsApp) can keep addressing the same inbox across rejoins.
    members: members.map((m) => ({ name: m.name, role: sanitizeRole(m.role), ...(m.id ? { id: m.id } : {}) })),
  });
  return { ok: true };
}

export async function upsertPresetMember(root, team, name, role, extra = {}) {
  const preset = (await loadPreset(root, team)) || { name: team, savedAt: Date.now(), members: [] };
  const prev = preset.members.find((m) => m.name === name) || {};
  const entry = { name, role: sanitizeRole(role), ...(prev.id ? { id: prev.id } : {}), ...(extra.id ? { id: extra.id } : {}) };
  const idx = preset.members.findIndex((m) => m.name === name);
  if (idx >= 0) preset.members[idx] = entry;
  else preset.members.push(entry);
  preset.savedAt = Date.now();
  await writeJsonAtomic(path.join(teamDir(root, team), "preset.json"), preset);
}

export async function removePresetMember(root, team, name) {
  const preset = await loadPreset(root, team);
  if (!preset) return;
  preset.members = preset.members.filter((m) => m.name !== name);
  preset.savedAt = Date.now();
  await writeJsonAtomic(path.join(teamDir(root, team), "preset.json"), preset);
}

// Refresh the preset from the current live roster (explicit /team preset save).
export async function refreshPresetFromRoster(root, team) {
  const members = await loadMembers(root, team);
  const rows = Object.values(members)
    .filter((m) => m && m.name)
    .map((m) => ({ name: m.name, role: m.role || "agent" }));
  return savePreset(root, team, rows);
}

// ---------------------------------------------------------------------------
// Standing briefing: the team mission / standing orders. Set by the
// coordinator (team briefing --body "..."), injected into every member's
// turn. Optional; when absent agents fall back to asking the coordinator.
// ---------------------------------------------------------------------------

export async function loadBrief(root, team) {
  try {
    const text = await fsp.readFile(path.join(teamDir(root, team), "brief.md"), "utf8");
    return text.trim() || null;
  } catch {
    return null;
  }
}

export async function saveBrief(root, team, text) {
  if (!(await teamExists(root, team))) {
    return { ok: false, error: `Team "${team}" does not exist.` };
  }
  await writeTextAtomic(path.join(teamDir(root, team), "brief.md"), text);
  await appendTeamLog(root, team, { ts: Date.now(), event: "brief_updated" });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Project memory: MEMORY.md in the working directory, shared by all team
// members (they share the repo). Appended via team memo / /team memo; seeded
// with a header on first use. Concurrent appends are serialized with a lock.
// ---------------------------------------------------------------------------

// Project memory lives in the repo's agent-team/ folder so it never collides
// with other harnesses' root-level MEMORY.md / AGENTS.md conventions.
export const MEMO_DIR_NAME = "agent-team";
export const MEMO_FILE_NAME = "MEMORY.md";

export function memoFile(cwd) {
  return path.join(cwd || ".", MEMO_DIR_NAME, MEMO_FILE_NAME);
}

export async function memoRead(cwd) {
  try {
    return await fsp.readFile(memoFile(cwd), "utf8");
  } catch {
    return null;
  }
}

export async function memoAppend(cwd, { team, name, role, body }) {
  const file = memoFile(cwd); // <cwd>/agent-team/MEMORY.md
  const dir = path.dirname(file);
  // The lock dir lives inside agent-team/, so create it before locking.
  await fsp.mkdir(dir, { recursive: true });
  return withDirLock(dir, async () => {
    let existing = "";
    try {
      existing = await fsp.readFile(file, "utf8");
    } catch {
      /* new file */
    }
    const lines = [];
    if (!existing.trim()) {
      lines.push(`# Project Memory — team ${team}`);
      lines.push("");
      lines.push(
        "Shared working memory for the team. Append dated entries with `team memo`;",
      );
      lines.push("new members read this file first. Add decisions, file maps, gotchas, and next steps.");
      lines.push("");
      lines.push("---");
      lines.push("");
    }
    const when = new Date().toISOString().slice(0, 16).replace("T", " ");
    lines.push(`## ${when} · ${name} (${role})`);
    lines.push("");
    lines.push(String(body || "").trim());
    lines.push("");
    lines.push("---");
    lines.push("");
    await writeTextAtomic(file, existing + lines.join("\n"));
    return { ok: true, file };
  });
}

// ---------------------------------------------------------------------------
// Await replies: poll my inbox until the expected members have replied (or
// the timeout / abort signal fires). Drained messages are consumed (read ==
// consumed, like `inbox`). Testable: pollMs is injectable.
// ---------------------------------------------------------------------------

export async function awaitReplies(
  root,
  team,
  selfId,
  expectedNames,
  { mode = "all", timeoutMs = 3 * 60 * 1000, pollMs = 3000, signal } = {},
) {
  const want = new Set(expectedNames.filter(Boolean));
  const replied = new Map(); // name -> messages[]
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  while (Date.now() < deadline) {
    if (signal?.aborted) break;
    const msgs = await drainInbox(root, team, selfId);
    for (const m of msgs) {
      const fromName = m.fromName || m.from;
      if (fromName && want.has(fromName) && m.from !== selfId) {
        if (!replied.has(fromName)) replied.set(fromName, []);
        replied.get(fromName).push(m);
      }
    }
    const allReplied = [...want].every((n) => replied.has(n));
    const anyReplied = replied.size > 0;
    if (mode === "all" ? allReplied : anyReplied) break;
    if (pollMs > 0) await sleep(pollMs);
  }
  const missing = [...want].filter((n) => !replied.has(n));
  return {
    replied: [...replied.entries()].map(([name, msgs]) => ({ name, msgs })),
    missing,
    elapsedMs: Date.now() - started,
    timedOut: missing.length > 0,
  };
}
