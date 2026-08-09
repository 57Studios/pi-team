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
// A same-name occupant is reclaimable when its session is dead: it marked
// itself offline (graceful shutdown) or its heartbeat has gone stale. Live
// members touch lastSeen every HEARTBEAT_MS, so a stale lastSeen means the
// process is gone (crash, power loss) — names of dead sessions are free.
export const STALE_MEMBER_MS = 5 * 60 * 1000;
export const HEARTBEAT_MS = 60 * 1000;
// Locks are held for milliseconds; anything older than this is a dead lock
// (process killed mid-operation) and safe to reclaim.
export const STALE_LOCK_MS = 5000;

export function teamsRoot(env = process.env) {
  const v = env.PI_TEAM_DIR?.trim();
  return v || TEAMS_ROOT_DEFAULT;
}

export function teamDir(root, team) {
  return path.join(root, team);
}

export function inboxDir(root, team, memberId) {
  return path.join(teamDir(root, team), "inbox", memberId);
}

export function boardDir(root, team) {
  return path.join(teamDir(root, team), "board");
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
    // arrives (max 3 auto-turns/min). Default off to avoid surprise work.
    autoRespond: Boolean(opts.autoRespond),
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

export function hasRole(role, wanted) {
  return roleSet(role).includes(String(wanted || "").trim().toLowerCase());
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
            error: `Name "${name}" is held by a LIVE member (${sid.slice(0, 8)}…). If that session is dead, it frees the name automatically once its heartbeat goes stale (~5 min), or a coordinator can run /team prune --hours 0 to reap it now. Otherwise pick a unique name with --name.`,
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
  const hits = Object.entries(members).filter(([id, m]) => m && m.name === t && id !== selfId);
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

export async function sendMessage(root, team, msg) {
  const meta = await loadTeam(root, team);
  if (!meta) return { ok: false, error: `Team "${team}" does not exist.` };
  const targets = msg.targets || [];
  if (!targets.length) return { ok: false, error: "no recipients" };
  const envelope = {
    id: `msg_${Date.now()}_${randomUUID().slice(0, 8)}`,
    type: msg.type || "dm", // dm | broadcast | task | report | system
    ts: Date.now(),
    from: msg.from,
    fromName: msg.fromName,
    fromRole: msg.fromRole,
    to: msg.to,
    subject: msg.subject || null,
    body: msg.body || "",
    priority: msg.priority || "normal",
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
  await appendLine(
    path.join(teamDir(root, team), "log.jsonl"),
    JSON.stringify({
      ts: envelope.ts,
      event: "message",
      id: envelope.id,
      type: envelope.type,
      from: envelope.fromName,
      to: envelope.to,
      subject: envelope.subject,
      priority: envelope.priority,
    }),
  );
  return { ok: true, delivered, id: envelope.id };
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

// ---------------------------------------------------------------------------
// Shared board (markdown artifacts)
// ---------------------------------------------------------------------------

export async function readBoard(root, team, topic) {
  const bdir = boardDir(root, team);
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

export async function writeBoard(root, team, topic, content) {
  if (!BOARD_TOPIC_RE.test(topic || "")) {
    return { ok: false, error: `invalid board topic "${topic}" (letters/digits/._- max 64)` };
  }
  const file = path.join(boardDir(root, team), `${topic}.md`);
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

export async function loadTasks(root, team) {
  const data = await readJson(path.join(teamDir(root, team), "tasks.json"), {
    tasks: [],
  });
  return Array.isArray(data.tasks) ? data.tasks : [];
}

// task shape:
// { id, title, body, assignee (name | role:<role> | null), status, priority,
//   kind ("work"|"review"), reviewOf (task id, when kind=review),
//   criteria[], dependsOn[], createdBy, createdByName, createdAt, assignedAt,
//   startedAt, doneAt, evidence, blockedReason, failReason, updatedAt }

export async function createTask(root, team, spec) {
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
    const tasks = await loadTasks(root, team);
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
    await writeJsonAtomic(path.join(teamDir(root, team), "tasks.json"), { tasks });
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
export async function updateTask(root, team, taskId, patch, actor) {
  const meta = await loadTeam(root, team);
  if (!meta) return { ok: false, error: `Team "${team}" does not exist.` };
  return withTeamLock(root, team, async () => {
    const tasks = await loadTasks(root, team);
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
          targets,
        });
        notified += targets.length;
      }
    }

    await writeJsonAtomic(path.join(teamDir(root, team), "tasks.json"), { tasks });
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
}

// ---------------------------------------------------------------------------
// Team preset: the intended roster (name + role), independent of liveness.
// Auto-updated on join/leave/role-change; survives crashes (it is on disk);
// used by `team revive` / `/team revive` to spawn the whole team back.
// ---------------------------------------------------------------------------

export async function loadPreset(root, team) {
  const data = await readJson(path.join(teamDir(root, team), "preset.json"), null);
  return data && Array.isArray(data.members) ? data : null;
}

export async function savePreset(root, team, members) {
  const file = path.join(teamDir(root, team), "preset.json");
  await writeJsonAtomic(file, {
    name: team,
    savedAt: Date.now(),
    members: members.map((m) => ({ name: m.name, role: sanitizeRole(m.role) })),
  });
  return { ok: true };
}

export async function upsertPresetMember(root, team, name, role) {
  const preset = (await loadPreset(root, team)) || { name: team, savedAt: Date.now(), members: [] };
  const entry = { name, role: sanitizeRole(role) };
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

export function memoFile(cwd) {
  return path.join(cwd || ".", "MEMORY.md");
}

export async function memoRead(cwd) {
  try {
    return await fsp.readFile(memoFile(cwd), "utf8");
  } catch {
    return null;
  }
}

export async function memoAppend(cwd, { team, name, role, body }) {
  const file = memoFile(cwd);
  const dir = path.dirname(file);
  return withDirLock(dir, async () => {
    await fsp.mkdir(dir, { recursive: true });
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
