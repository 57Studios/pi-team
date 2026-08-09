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
// A same-name occupant is only auto-replaced when its lastSeen is older than
// this, i.e. its session is stale/abandoned.
export const STALE_MEMBER_MS = 10 * 60 * 1000;
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
export async function withTeamLock(root, team, fn, timeoutMs = 4000) {
  const lock = path.join(teamDir(root, team), ".lock");
  const start = Date.now();
  for (;;) {
    try {
      await fsp.mkdir(lock);
      break;
    } catch {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`team lock timed out (${team})`);
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
  return String(role || "").trim().slice(0, 40) || "agent";
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
        const stale = Date.now() - (m.lastSeen || 0) > STALE_MEMBER_MS;
        if (!rejoin || !stale) {
          return {
            ok: false,
            error: `Name "${name}" is taken by another member (${sid.slice(0, 8)}…). Pick a unique name with --name.`,
          };
        }
        delete members[sid]; // auto-rejoin reclaims our name from a stale session
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
    await appendLine(
      path.join(teamDir(root, team), "log.jsonl"),
      JSON.stringify({
        ts: Date.now(),
        event: replaced ? "member_rejoined" : "member_joined",
        id,
        name,
        role,
      }),
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
      await appendLine(
        path.join(teamDir(root, team), "log.jsonl"),
        JSON.stringify({ ts: Date.now(), event: "member_left", id, name: m.name }),
      );
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
    await appendLine(
      path.join(teamDir(root, team), "log.jsonl"),
      JSON.stringify({ ts: Date.now(), event: "role_changed", id, role: m.role }),
    );
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
      .filter(([id, m]) => m && m.role === role && id !== selfId)
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
  return withTeamLock(root, team, async () => {
    const tasks = await loadTasks(root, team);
    if (tasks.some((t) => t.id === id)) {
      return { ok: false, error: `task id "${id}" already exists` };
    }
    const task = {
      id,
      title,
      body: String(spec.body || "").trim() || null,
      assignee,
      status: "queued",
      priority: spec.priority === "high" ? "high" : "normal",
      criteria: (spec.criteria || []).map((c) => String(c).trim()).filter(Boolean),
      dependsOn: (spec.dependsOn || []).map(String).filter(Boolean),
      createdBy: spec.createdBy || null,
      createdByName: spec.createdByName || null,
      createdAt: Date.now(),
      assignedAt: null,
      startedAt: null,
      doneAt: null,
      evidence: null,
      blockedReason: null,
      failReason: null,
      updatedAt: Date.now(),
    };
    tasks.push(task);
    await writeJsonAtomic(path.join(teamDir(root, team), "tasks.json"), { tasks });
    await appendLine(
      path.join(teamDir(root, team), "log.jsonl"),
      JSON.stringify({ ts: Date.now(), event: "task_created", task: id, title, assignee }),
    );
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
        await sendMessage(root, team, {
          type: "task",
          from: task.createdBy,
          fromName: task.createdByName || task.createdBy,
          fromRole,
          to: task.assignee,
          subject: `assigned: ${task.title}`,
          body:
            `Task: ${task.title}\n\n${task.body || ""}${criteriaText}\n\n` +
            `Complete it with: team task_done task_id=${task.id} --evidence "<what you changed, file refs, validation>"`,
          priority: "high",
          targets: tgt.ids,
        });
        notified = tgt.ids.length;
      }
    }
    return { ok: true, task, notified };
  });
}

// Validated task transition. Permission model (light, social):
//   - the assignee (by name), anyone with the assigned role, or a coordinator
//     may change status; unassigned tasks are claimable by anyone;
//   - reassignment requires the creator or a coordinator.
// Enforcement (the "typed artifact" bit): a task cannot flip to done without
// evidence. Unfinished dependencies produce warnings (not hard blocks) so the
// worker sees exactly what a gate would flag, without an engine.
export async function updateTask(root, team, taskId, patch, actor) {
  const meta = await loadTeam(root, team);
  if (!meta) return { ok: false, error: `Team "${team}" does not exist.` };
  return withTeamLock(root, team, async () => {
    const tasks = await loadTasks(root, team);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, error: `unknown task "${taskId}"` };
    const warnings = [];

    if (patch.status !== undefined && patch.status !== task.status) {
      const to = String(patch.status);
      if (!TASK_STATUSES.includes(to)) {
        return { ok: false, error: `invalid task status "${to}" (queued|running|blocked|failed|done)` };
      }
      const isAssignee = task.assignee
        ? task.assignee.startsWith("role:")
          ? actor.role === task.assignee.slice(5)
          : actor.name === task.assignee
        : true; // unassigned: claimable by anyone
      const canManage = isAssignee || actor.role === "coordinator";
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
        for (const did of task.dependsOn) {
          const dep = tasks.find((x) => x.id === did);
          if (!dep || dep.status !== "done") warnings.push(did);
        }
        task.evidence = evidence;
        task.doneAt = Date.now();
      }
      if (to === "blocked") task.blockedReason = String(patch.reason || "").trim() || null;
      if (to === "running") {
        for (const did of task.dependsOn) {
          const dep = tasks.find((x) => x.id === did);
          if (!dep || dep.status !== "done") warnings.push(did);
        }
        task.startedAt = Date.now();
      }
      if (to === "failed") task.failReason = String(patch.reason || "").trim() || null;
      if (to === "queued") {
        task.startedAt = null;
        task.doneAt = null;
        task.evidence = null;
        task.blockedReason = null;
        task.failReason = null;
      }
      task.status = to;
      task.updatedAt = Date.now();
      await appendLine(
        path.join(teamDir(root, team), "log.jsonl"),
        JSON.stringify({ ts: Date.now(), event: "task_status", task: taskId, status: to, by: actor.name }),
      );
    }

    // Atomic with the transition: notify the creator when a task completes.
    let notified = 0;
    if (task.status === "done" && task.createdByName) {
      const members = await loadMembers(root, team);
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
        notified = tgt.ids.length;
      }
    }

    if (patch.assignee !== undefined) {
      const to = String(patch.assignee).trim();
      if (!to) return { ok: false, error: "assignee cannot be empty" };
      const isCreator = task.createdBy === actor.id;
      if (actor.role !== "coordinator" && !isCreator) {
        return { ok: false, error: "only the task creator or a coordinator may reassign" };
      }
      task.assignee = to;
      task.assignedAt = Date.now();
      task.updatedAt = Date.now();
    }

    await writeJsonAtomic(path.join(teamDir(root, team), "tasks.json"), { tasks });
    return { ok: true, task, warnings, notified };
  });
}
