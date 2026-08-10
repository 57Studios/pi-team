/**
 * pi-team: turn multiple pi instances into a coordinated agent team.
 *
 * Like jcode's swarm: instances join a team (with the roles you assign),
 * DM each other, assign tasks, post reports, and share a board — all over a
 * shared directory (~/.pi/teams/<team>), no server required.
 *
 * Install: put this directory at ~/.pi/agent/extensions/pi-team/ (auto-
 * discovered, hot-reloadable with /reload).
 *
 * Usage:
 *   /team create invader --name Alice --role coordinator   (instance 1)
 *   /team join  invader --name Bob   --role implementer    (instance 2)
 *   /team join  invader --name Carol --role reviewer       (instance 3)
 *
 * Agents coordinate via the `team` tool:
 *   team dm Alice --body "..."          team task role:implementer --subject ... --body ...
 *   team report --body "done"           team inbox / roster / board_write / board_read
 *
 * Spawned workers: PI_TEAM=<team> PI_TEAM_ROLE=<role> PI_TEAM_NAME=<name> pi
 *   auto-joins on start (also used by `team spawn`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import * as bus from "./bus.ts";

const ACTIONS = [
  "create", "join", "leave", "roster", "dm", "broadcast", "task", "report",
  "inbox", "board_write", "board_read", "status", "whoami", "set_role",
  "spawn", "selftest",
  "task_create", "task_list", "task_show", "task_start", "task_done", "task_blocked", "task_fail", "task_assign",
  "preset_show", "preset_save", "preset_create", "revive", "briefing", "memo", "config", "await_members", "kick", "checkin", "later", "timers", "search", "clear", "export", "import",
] as const;

const TEAM_IDENTITY_ENTRY = "team-identity";

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let memberId: string | undefined;
  // Last team I belonged to, cached so session_shutdown can mark me offline
  // (roster hygiene for teammates) without a full identity re-resolution.
  let lastTeam: { root: string; team: string; id: string } | undefined;
  let watcher: fs.FSWatcher | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let widgetTimer: NodeJS.Timeout | undefined;
  let lastTouchAt = 0;
  // Standing-briefing injection state: inject on the first run of a session,
  // after compaction, or when the briefing content changed — not every prompt.
  let lastBriefingHash: number | null = null;
  let briefingDirty = false;
  let launchedFromFlag = false;
  const autoTurns: number[] = [];

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  function envCfg() {
    return {
      root: bus.teamsRoot(process.env),
      team: process.env.PI_TEAM?.trim() || undefined,
      role: process.env.PI_TEAM_ROLE?.trim() || undefined,
      name: process.env.PI_TEAM_NAME?.trim() || undefined,
    };
  }

  function safeSessionId(c: ExtensionContext): string {
    try {
      const id = c.sessionManager.getSessionId();
      if (id) return id;
    } catch {
      /* fall through */
    }
    return `unknown-${Math.random().toString(36).slice(2, 10)}`;
  }

  // Session-scoped identity: recorded with pi.appendEntry on join, restored on
  // session_start (survives restarts and /resume). /new starts fresh; rejoin
  // with /team join (one command) or PI_TEAM env.
  function sessionIdentity(c: ExtensionContext) {
    try {
      let entries: any[] = [];
      try {
        entries = c.sessionManager.getEntries();
      } catch {
        entries = c.sessionManager.getBranch();
      }
      for (const entry of entries) {
        if (entry.type === "custom" && entry.customType === TEAM_IDENTITY_ENTRY) {
          const d = entry.data as { root?: string; team?: string; name?: string; role?: string };
          if (d && d.team && d.name) {
            return {
              root: d.root || bus.teamsRoot(process.env),
              team: d.team,
              name: d.name,
              role: d.role || "agent",
            };
          }
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  // Resolve who I am: env override wins, else session identity. Auto-rejoins
  // (reclaiming our name if a stale session holds it).
  async function myTeam(c?: ExtensionContext) {
    const c2 = c ?? ctx;
    if (!c2) return null;
    const cfg = envCfg();
    const env = cfg.team
      ? { root: cfg.root, team: cfg.team, name: cfg.name, role: cfg.role }
      : null;
    const ident = env || sessionIdentity(c2);
    if (!ident) return null;
    const root = ident.root;
    if (!(await bus.teamExists(root, ident.team))) return null;
    const id = safeSessionId(c2);
    const jr = await bus.joinMember(root, ident.team, {
      id,
      name: ident.name,
      role: ident.role,
      rejoin: true,
    });
    if (!jr.ok) return null;
    memberId = id;
    lastTeam = { root, team: ident.team, id };
    // Note: joinMember already resets status to "idle" on (re)join, so a
    // resumed session implicitly revives from "offline".
    return {
      id,
      root,
      team: ident.team,
      dir: bus.teamDir(root, ident.team),
      name: jr.member.name,
      role: jr.member.role,
    };
  }

  function saveSessionIdentity(c: ExtensionContext, ident: { root: string; team: string; name: string; role: string }) {
    try {
      pi.appendEntry(TEAM_IDENTITY_ENTRY, ident);
    } catch {
      /* non-fatal */
    }
  }

  function rosterLine(team: string, members: ReturnType<typeof bus.rosterList>) {
    const parts = members.map((m) => `${m.name}(${m.role})`);
    return `[team:${team}] ${parts.join(", ")}`;
  }

  // The standing briefing every member sees at the start of every turn: who
  // they are, the team mission, and — crucially — who they report to and where
  // completed work goes next (derived from the roster, so it tracks role
  // changes automatically).
  function buildBriefing(
    me: NonNullable<Awaited<ReturnType<typeof myTeam>>>,
    members: Record<string, any>,
    brief: string | null,
  ): string {
    const roster = bus.rosterList(members, me.id);
    const now = Date.now();
    const dead = (m: any) => bus.isMemberDead(m, now);
    const mark = (m: any) => `${m.name}(${m.role}${dead(m) ? ", offline" : ""})`;
    const coordinators = roster.filter((m) => bus.hasRole(m.role, "coordinator"));
    const reviewers = roster.filter((m) => bus.hasRole(m.role, "reviewer"));
    const researchers = roster.filter((m) => bus.hasRole(m.role, "researcher"));
    const coordNames = coordinators.map(mark).join(", ");
    const revNames = reviewers.map(mark).join(", ");
    const resNames = researchers.map(mark).join(", ");
    const amResearcher = bus.hasRole(me.role, "researcher");
    const lines = [`You are ${me.name} (${me.role}) in team "${me.team}".`];
    if (brief?.trim()) {
      lines.push(`Mission: ${brief.trim()}`);
    } else {
      lines.push(`Mission: not set yet — ask the coordinator${coordinators.length ? ` (${coordNames})` : ""} for the team's objectives, or check the board.`);
    }
    if (roster.length) {
      lines.push(`Team: ${roster.map(mark).join(", ")}`);
    }
    lines.push(
      `Report to: role:coordinator${coordinators.length ? ` (${coordNames})` : ""} — use team report for completion reports; task_blocked/task_fail auto-notify them.`,
    );
    if (reviewers.length) {
      lines.push(
        `Pass completed work to: role:reviewer (${revNames}) — created review tasks land there and bounce failed work back to you.`,
      );
    } else {
      lines.push("No reviewers on this team — the coordinator reviews completed work.");
    }
    lines.push(
      "Project memory: agent-team/MEMORY.md in the working directory is AUTO-INJECTED into your context (re-injected when it changes) — read the full file with: read agent-team/MEMORY.md when you need deep context. Record decisions, gotchas, and next steps with team memo.",
    );
    // Team protocol (role-aware, derived from the roster).
    lines.push("Protocol:");
    if (amResearcher) {
      lines.push(
        `- Your duty: when any member DMs you a research request, investigate thoroughly, send the FULL report back to the requester, and send a one-line tldr to role:coordinator${coordinators.length ? ` (${coordNames})` : ""}. Explicitly flag anything you could not verify.`,
      );
      lines.push("- If your work crosses another member's path, DM them directly to coordinate.");
      lines.push("- If you feel uncertain about anything, say so explicitly in your report and note what you could not verify.");
    } else {
      lines.push(
        "- If your work crosses another member's files/scope, DM them directly to coordinate and resolve conflicts — don't route everything through the coordinator.",
      );
      lines.push(
        "- Idle members auto-start a turn when you DM/broadcast them (rate-limited ~3/min) — messages are read automatically, no one needs to prompt them. For an urgent immediate turn, mark the message wake: team dm --wake.",
        "- Status checks are NON-BLOCKING: use team checkin (wake-DMs everyone, then END YOUR TURN). Replies auto-wake you one at a time with progress; never sleep or poll the inbox waiting for replies.",
        "- To be woken by the harness later (e.g. check back in 30 min), set a timer: team later --minutes 30 --body \"...\" (or --at HH:MM). The harness pings you with a turn when it fires; timers survive restarts.",
        "- Web search is built in: team search \"query\" (SearXNG on localhost — no API key; use --categories news for news). Scout/research work: search first, then verify the top hits before citing.",
        "- Cross-team comm is LEAD-TO-LEAD: only coordinators (Hub/Boss/Lead) may DM another team, and only to that team's coordinator — team dm to:'Zilla/Zed' or to:'Zilla/role:coordinator'. Non-leads asking for cross-team coordination should ask their own coordinator to relay. dm/report only; boards and tasks stay per-team.",
        "- Task boards are PER-PROJECT: when you work inside a repo that has an agent-team/ directory, task_create/task_list/board_write/board_read/clear operate on THAT project's board (<repo>/agent-team/tasks.json + board/). Otherwise they use the team board. The team audit log stays team-level.",
      );
      if (researchers.length) {
        lines.push(
          `- Research: whenever you need something searched, investigated, or fact-checked, DM role:researcher (${resNames}) with the question. They send the full report back to you and a tldr to the coordinator.${researchers.length && researchers.every(dead) ? " The researcher is currently offline — ask the coordinator to wake them (team revive)." : ""}`,
        );
        lines.push(
          "- Confidence: if you feel uncertain about a design, a dependency, or any fact, immediately ask the researcher to investigate before proceeding — do not guess.",
        );
      } else {
        lines.push(
          "- Research/confidence: no researcher on this team — if you feel uncertain or need investigation, say so explicitly in your report, note what you could not verify, and let the coordinator decide next steps.",
        );
      }
    }
    return lines.join("\n");
  }

  function hashStr(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h;
  }

  function formatMessages(msgs: Array<Record<string, any>>): string {
    const blocks = msgs.map((m) => {
      const kind =
        m.type === "task"
          ? "TASK"
          : m.type === "task_done"
            ? "TASK DONE"
            : m.type === "task_blocked"
              ? "TASK BLOCKED"
              : m.type === "task_failed"
                ? "TASK FAILED"
                : m.type === "task_bounced"
                  ? "REVIEW FAILED"
                  : m.type === "task_low_confidence"
                    ? "LOW CONFIDENCE"
                    : m.type === "report"
                    ? "REPORT"
                    : m.type === "broadcast"
                      ? "BROADCAST"
                      : "DM";
      const head = `${kind} from ${m.fromName || m.from} (${m.fromRole || "agent"}${m.fromTeam ? ` · ${m.fromTeam}` : ""})${
        m.subject ? ` — ${m.subject}` : ""
      }${m.priority === "high" ? " [high priority]" : ""}${m.wake ? " [wake]" : ""}`;
      return `${head}\n${m.body || ""}`.trimEnd();
    });
    return `[team inbox — ${msgs.length} new message${msgs.length > 1 ? "s" : ""}]\n\n${blocks.join("\n\n")}`;
  }

  async function throttledTouch(me: NonNullable<Awaited<ReturnType<typeof myTeam>>>) {
    const now = Date.now();
    if (now - lastTouchAt < 30_000) return;
    lastTouchAt = now;
    await bus.touchMember(me.root, me.team, me.id).catch(() => {});
  }

  // Standing cadence timers from team.json (autoTimers): auto-arm the ones
  // matching me at session start, and re-arm after each fire so the cadence
  // continues with zero model cooperation. Dedup: never two pending with the
  // same tag.
  async function armAutoTimers(me: NonNullable<Awaited<ReturnType<typeof myTeam>>>) {
    try {
      const meta = await bus.loadTeam(me.root, me.team);
      const autos: Array<{ name: string; minutes: number; body: string; tag: string }> =
        (meta as any)?.autoTimers || [];
      for (const a of autos) {
        if (a.name !== me.name) continue;
        const pending = await bus.listTimers(me.root, me.team, me.id);
        if (pending.some((t: any) => t.tag === a.tag)) continue;
        await bus.setTimer(me.root, me.team, me.id, { minutes: a.minutes, body: a.body, tag: a.tag });
      }
    } catch { /* best effort */ }
  }

  // Arm persisted self-ping timers: due ones fire now (missed while offline),
  // future ones schedule a wake. Called on session_start after joining.
  const pendingTimerTimeouts: NodeJS.Timeout[] = [];
  async function armTimers(me: NonNullable<Awaited<ReturnType<typeof myTeam>>>) {
    for (const t of pendingTimerTimeouts) clearTimeout(t);
    pendingTimerTimeouts.length = 0;
    const fire = (t: any) => {
      const c = ctx;
      if (!c) return;
      const content = `[scheduled ping] ${t.body || "(no note)"}`;
      if (c.hasUI) c.ui.notify(`[team:${me.team}] ⏰ timer fired: ${t.body || "ping"}`, "info");
      // Deliver as a REAL user message: it always renders with the content and
      // always triggers a turn. The custom-message renderer path proved fragile
      // (pi could echo it with empty content -> the empty "[team]" box).
      pi.sendUserMessage(content, { deliverAs: "followUp" });
    };
    // After a fire, standing cadence continues: re-create the next timer AND
    // schedule its timeout (armTimers claims-due + schedules all pending).
    const rearm = async () => {
      await armAutoTimers(me);
      await armTimers(me);
    };
    try {
      const due = await bus.claimDueTimers(me.root, me.team, me.id);
      for (const t of due) fire(t);
      if (due.length) await rearm();
      const future = await bus.listTimers(me.root, me.team, me.id);
      for (const t of future) {
        const wait = Math.max(1000, t.dueAt - Date.now());
        const to = setTimeout(async () => {
          try {
            const claimed = await bus.claimDueTimers(me.root, me.team, me.id, t.dueAt + 1);
            for (const ct of claimed) fire(ct);
            if (claimed.length) await rearm();
          } catch { /* best effort */ }
        }, wait);
        pendingTimerTimeouts.push(to);
      }
    } catch { /* best effort */ }
  }

  function stopWatcher() {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = undefined;
    }
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
      watcher = undefined;
    }
  }

  function allowAutoTurn(): boolean {
    // Check the budget WITHOUT consuming a slot on no-op checks; only a
    // granted auto-turn counts. Otherwise repeated watcher checks burn the
    // 3/min budget and delay real messages.
    const now = Date.now();
    const recent = autoTurns.filter((t) => now - t < 60_000);
    if (recent.length >= 3) return false;
    recent.push(now);
    autoTurns.length = 0;
    autoTurns.push(...recent);
    return true;
  }

  // Watch my inbox. New mail while busy -> steer-inject before the next LLM
  // call (soft interrupt). New mail while idle -> notify; autoRespond setting
  // optionally triggers a turn (rate-limited). before_agent_start drains
  // whatever remains at the next prompt.
  function startWatcher(me: NonNullable<Awaited<ReturnType<typeof myTeam>>>) {
    stopWatcher();
    const dir = bus.inboxDir(me.root, me.team, me.id);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    let retryTimer: NodeJS.Timeout | undefined;
    let busy = false;
    // Re-check shortly when the auto-turn budget is exhausted so unread
    // messages are picked up without the user having to prompt the agent.
    const scheduleRetry = () => {
      if (retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        watcherCheck();
      }, 10_000);
    };
    // Heartbeat while in a team: lastSeen is a real liveness signal, so a
    // crashed/power-loss session releases its name once the heartbeat goes
    // stale (STALE_MEMBER_MS) and the team can be revived cleanly.
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      bus.touchMember(me.root, me.team, me.id).catch(() => {});
    }, bus.HEARTBEAT_MS);
    // Keep things live even with zero events: fs.watch can silently miss an
    // inbox write, which stranded messages for minutes (Mint's report waited
    // ~2.5 min once). A periodic full check guarantees a bounded reaction:
    // drains new mail and auto-turns (rate-limited) the same way fs.watch
    // does, plus refreshes the footer so member counts never go stale.
    if (widgetTimer) clearInterval(widgetTimer);
    widgetTimer = setInterval(() => {
      watcherCheck().catch(() => {});
    }, 30_000);
    const watcherCheck = async () => {
      if (busy) return;
      busy = true;
      try {
          const c = ctx;
          if (!c) return;
          const pending = await bus.pendingCount(me.root, me.team, me.id);
          if (!pending) return;
          const hasWake = await bus.hasWakePending(me.root, me.team, me.id);
          const meta = await bus.loadTeam(me.root, me.team);
          // autoRespond defaults ON: an idle member auto-starts a turn for any
          // new message (rate-limited), so nothing waits on a manual prompt.
          const autoRespond = meta?.autoRespond !== false;
          const interject = meta?.interject !== false;
          const emitBriefing = (content: string, opts: Record<string, any>) => {
            if (!content.trim()) return; // never deliver an empty message
            // Real user message: always visible with content, always triggers a
            // turn (idle) or steers (busy). No custom-message renderer, so no
            // empty "[team]" box is possible.
            pi.sendUserMessage(content, opts);
          };
          if (!c.isIdle() && interject) {
            // Busy: steer the messages in before the next LLM call (soft interrupt).
            const msgs = await bus.drainInbox(me.root, me.team, me.id);
            if (msgs.length) {
              const senders = msgs.map((m: any) => m.fromName).filter(Boolean);
              const rec = await bus.recordCheckinReplies(me.root, me.team, me.id, senders);
              emitBriefing(formatMessages(msgs) + checkinProgressLine(rec), { deliverAs: "steer" });
            }
          } else if (c.isIdle() && (autoRespond || hasWake)) {
            // Urgent messages (wake/report/task — wake is set by the sender or
            // the report path) always trigger a turn immediately: no budget
            // wait, no retry. Only ordinary DMs are rate-limited.
            if (hasWake || allowAutoTurn()) {
              const msgs = await bus.drainInbox(me.root, me.team, me.id);
              if (msgs.length) {
                const senders = msgs.map((m: any) => m.fromName).filter(Boolean);
                const rec = await bus.recordCheckinReplies(me.root, me.team, me.id, senders);
                emitBriefing(formatMessages(msgs) + checkinProgressLine(rec), { deliverAs: "followUp" });
              }
            } else {
              scheduleRetry(); // rate-limited: pick it up on the next window
            }
          } else {
            // autoRespond explicitly OFF (or busy with interject off): the
            // member opted out of auto-turns, so surface it in the UI.
            if (c.hasUI) {
              c.ui.notify(`[team:${me.team}] ${pending} new message(s) for you. Prompt your agent to read them.`, "info");
            }
          }
          await refreshWidget(c, me);
        } catch {
          /* watcher is best-effort */
        } finally {
          busy = false;
        }
      };
    watcher = fs.watch(dir, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(watcherCheck, 250);
    });
  }

  // -------------------------------------------------------------------------
  // footer widget + hygiene sweep
  // -------------------------------------------------------------------------

  // Set the terminal window/tab title so each agent's window shows who it is.
  function applyTitle(c: ExtensionContext | undefined, me: NonNullable<Awaited<ReturnType<typeof myTeam>>>) {
    try {
      c?.ui.setTitle(`${me.team} / ${me.name} (${me.role})`);
    } catch {
      /* best-effort */
    }
  }

  // Seed MEMORY.md in the working directory on first use (no-op if present).
  async function seedMemo(c: ExtensionContext, me: NonNullable<Awaited<ReturnType<typeof myTeam>>>) {
    try {
      if (!(await bus.memoRead(c.cwd))) {
        await bus.memoAppend(c.cwd, {
          team: me.team,
          name: me.name,
          role: me.role,
          body: `Team "${me.team}" is working in this directory (${me.role}). Record decisions, file maps, gotchas, and next steps here with team memo.`,
        });
      }
    } catch {
      /* best-effort */
    }
  }

  let lastWidgetAt = 0;
  async function refreshWidget(c: ExtensionContext | undefined, me: NonNullable<Awaited<ReturnType<typeof myTeam>>>, force = false) {
    if (!c?.hasUI) return;
    const now = Date.now();
    if (!force && now - lastWidgetAt < 15_000) return;
    lastWidgetAt = now;
    try {
      const store = c?.cwd ? bus.resolveTaskStore(me.root, me.team, c.cwd) : null;
      const [members, tasks, pending] = await Promise.all([
        bus.loadMembers(me.root, me.team),
        bus.loadTasks(me.root, me.team, store?.dir),
        bus.pendingCount(me.root, me.team, me.id),
      ]);
      const done = tasks.filter((t: any) => t.status === "done").length;
      const text = `[team:${me.team}] ${Object.keys(members).length} members · ${pending} msg · ${done}/${tasks.length} tasks done`;
      c.ui.setStatus("team", text);
    } catch {
      /* widget is best-effort */
    }
  }

  let lastSweepAt = 0;
  async function maybeSweep(me: NonNullable<Awaited<ReturnType<typeof myTeam>>>) {
    const now = Date.now();
    if (now - lastSweepAt < 60 * 60 * 1000) return;
    lastSweepAt = now;
    await bus.sweepTeam(me.root, me.team).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  pi.on("session_compact", () => {
    // Compaction summarized away context — the standing briefing must return.
    briefingDirty = true;
  });

  // One-shot launcher: `pi --team <name>` joins THIS terminal as the preset's
  // coordinator (Optimus for Alpha) and spawns every other preset member in
  // new terminals, pre-joined with their name/role.
  async function launchFromFlag(c: ExtensionContext, team: string) {
    if (launchedFromFlag) return;
    launchedFromFlag = true;
    const root = bus.teamsRoot(process.env);
    // Case-insensitive team-name resolution: `--team zilla` finds "Zilla".
    const resolved = (await bus.resolveTeamName(root, team)) || team;
    let preset = null;
    try {
      preset = await bus.loadPreset(root, resolved);
    } catch {
      preset = null;
    }
    if (!preset?.members?.length) {
      // Fallback: materialize the team from the versioned teams/ dir in the
      // repo (fresh clone on another machine -> pi --team zilla just works).
      const def = findTeamDef(resolved);
      if (def) {
        const imp = await bus.importTeam(root, def).catch(() => null);
        // The def may be capitalized differently than the CLI arg ("zilla" ->
        // "Zilla"); re-resolve the ACTUAL team name after importing.
        if (imp?.ok) resolved = (await bus.resolveTeamName(root, team)) || imp.name;
        preset = await bus.loadPreset(root, resolved).catch(() => null);
      }
    }
    if (!preset?.members?.length) {
      try {
        c.ui.notify(`[team] No preset found for team "${team}". Create it first: /team preset create Optimus=coordinator, reviewer Bee=implementer ...`, "error");
      } catch { /* ignore */ }
      return;
    }
    // This terminal becomes the first coordinator-role member, else the first.
    const coord = preset.members.find((m: any) => bus.hasRole(m.role, "coordinator")) || preset.members[0];
    process.env.PI_TEAM = resolved;
    process.env.PI_TEAM_NAME = coord.name;
    process.env.PI_TEAM_ROLE = coord.role;
    process.env.PI_TEAM_DIR = root;
    const me = await myTeam(c);
    if (!me) return;
    startWatcher(me);
    applyTitle(c, me);
    await seedMemo(c, me);
    await maybeSweep(me);
    await refreshWidget(c, me, true);
    // Spawn every other preset member that is not currently live.
    const members = await bus.loadMembers(root, resolved).catch(() => ({}));
    const now = Date.now();
    const spawned: string[] = [];
    const skipped: string[] = [];
    for (const m of preset.members) {
      if (m.name === me.name) continue;
      const live = Object.values(members).some(
        (x: any) =>
          x.name === m.name &&
          x.status !== "offline" &&
          now - (x.lastSeen || 0) < 90_000, // heartbeat is 60s: >90s = dead, respawn
      );
      if (live) {
        skipped.push(m.name);
        continue;
      }
      await spawnWorker(me, { role: m.role, name: m.name }, c);
      spawned.push(m.name);
    }
    try {
      c.ui.notify(
        `[team] Launched "${team}": you are ${me.name} (${me.role}). Spawned: ${spawned.join(", ") || "(none)"} · already live: ${skipped.join(", ") || "(none)"}`,
        "info",
      );
    } catch { /* ignore */ }
  }

  pi.registerFlag("team", {
    description: "Auto-launch a team on startup: this terminal joins as the preset's coordinator and spawns all other preset members in new terminals.",
    type: "string",
    default: "",
  });

  // pi's own extension-flag plumbing (unknownFlags -> applyExtensionFlagValues)
  // is unreliable across reloads in non-interactive modes, so read the flag
  // straight from the CLI argv. Supports --team <name> and --team=<name>.
  function cliTeamFlag(): string {
    const args = process.argv;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--team") {
        const v = args[i + 1];
        if (v && !v.startsWith("-")) return v.trim();
      } else if (a.startsWith("--team=")) {
        return a.slice("--team=".length).trim();
      }
    }
    return "";
  }

  pi.on("session_start", async (_event, c) => {
    ctx = c;
    lastTouchAt = 0;
    lastBriefingHash = null;
    briefingDirty = false;
    const argTeam = cliTeamFlag();
    // Windows wrappers can pass this environment variable when pi parses
    // extension flags before the extension has registered them.
    const envTeam = process.env.PI_TEAM_LAUNCH;
    const flag = typeof argTeam === "string" && argTeam.trim()
      ? argTeam
      : (typeof envTeam === "string" && envTeam.trim() ? envTeam : pi.getFlag("team"));
    if (typeof flag === "string" && flag.trim() && !launchedFromFlag) {
      await launchFromFlag(c, flag.trim());
      return; // launchFromFlag already joined and set up the session
    }
    const me = await myTeam(c);
    if (me) {
      startWatcher(me);
      // auto-arm standing timers first: armTimers schedules timeouts for
      // whatever timers already exist, so the standing ones must exist first.
      await armAutoTimers(me);
      await armTimers(me);
      applyTitle(c, me);
      // Pi may set its own title after session_start (notably on Windows), so
      // re-apply ours after its startup work has completed.
      setTimeout(() => applyTitle(c, me), 500);
      setTimeout(() => applyTitle(c, me), 2_000);
      await seedMemo(c, me);
      await maybeSweep(me);
      await refreshWidget(c, me, true);
      if (c.hasUI) {
        c.ui.notify(`[team:${me.team}] you are ${me.name} (${me.role}).`, "info");
      }
    }
  });

  pi.on("session_shutdown", () => {
    stopWatcher();
    // Mark myself offline in the roster so teammates see the truth. Uses the
    // fully synchronous write (no await between lock and release) so pi cannot
    // kill the process mid-operation and orphan the lock dir.
    if (lastTeam) {
      bus.setMemberStatusSync(lastTeam.root, lastTeam.team, lastTeam.id, "offline");
    }
    try {
      ctx?.ui.setStatus("team", "");
    } catch {
      /* ignore */
    }
    lastTeam = undefined;
    ctx = undefined;
  });

  // Inject pending DMs + the standing briefing into the start of each turn.
  pi.on("before_agent_start", async (_event, c) => {
    const me = await myTeam(c);
    if (!me) return;
    await throttledTouch(me);
    await refreshWidget(c, me);
    const msgs = await bus.drainInbox(me.root, me.team, me.id);
    const members = await bus.loadMembers(me.root, me.team);
    const brief = await bus.loadBrief(me.root, me.team);
    const briefingBlock = `[team-context] ${buildBriefing(me, members, brief)}`;
    // Project memory (agent-team/MEMORY.md) rides along: auto-injected like
    // AGENTS.md would be, but capped and only re-injected when it changes.
    const memo = c.cwd ? await bus.memoRead(c.cwd) : null;
    const MEMO_MAX = 20_000;
    const memoBlock = memo
      ? `[project memory — agent-team/MEMORY.md]\n${
          memo.length > MEMO_MAX
            ? memo.slice(-MEMO_MAX) + `\n… (${memo.length} chars total; read the full file with: read agent-team/MEMORY.md)`
            : memo
        }`
      : "";
    const memoHash = memo ? hashStr(memo) : "";
    // Hash on a liveness-stripped copy: idle/offline flapping must NOT
    // re-inject the briefing every prompt (that was an empty-looking
    // "[team]" box on every prompt). Only stable changes (role, mission,
    // roster membership, project memory) trigger re-injection.
    const briefingHash = hashStr(briefingBlock.replace(/, offline\)/g, ")") + "|memo:" + memoHash);
    // Inject only when needed: first run of a session, after compaction, or
    // when role/mission/roster changed. Steady state costs zero tokens and
    // the briefing still lives in context (it was already injected). Compaction
    // is the only way pi prunes context, and it fires session_compact below.
    const injectBriefing =
      lastBriefingHash === null || briefingDirty || briefingHash !== lastBriefingHash;
    const parts: string[] = [];
    if (msgs.length) parts.push(formatMessages(msgs));
    if (injectBriefing) {
      lastBriefingHash = briefingHash;
      briefingDirty = false;
      parts.push(briefingBlock);
      if (memoBlock) parts.push(memoBlock);
    }
    if (!parts.length) return;
    const content = parts.join("\n\n");
    if (!content.trim()) return;
    return {
      message: {
        customType: "team-briefing",
        content,
        // Visible confirmation that the briefing was injected (the empty-box
        // bug was fixed at the source: watcher/timers deliver via real user
        // messages, the renderer never draws an empty box, and this content
        // is never empty).
        display: true,
      },
    };
  });

  // Non-blocking status check: wake-DM the targets, record a checkin, and let
  // replies auto-wake the sender with progress. No sleeping, no polling.
  async function checkinMembers(
    me: NonNullable<Awaited<ReturnType<typeof myTeam>>>,
    { to = "", body = "" } = {},
  ) {
    const root = bus.teamsRoot(process.env); // helper lives outside the per-case root scope
    const members = await bus.loadMembers(root, me.team);
    // Member records have no `id` field — the id is the map key.
    const others = Object.entries(members)
      .filter(([id, m]: [string, any]) => m && id !== me.id && m.status !== "offline")
      .map(([id, m]: [string, any]) => ({ id, ...m }));
    const question = String(body || "").trim() || "Status check: reply with a one-line status of what you are working on.";
    let ids: string[] = [];
    let targetLabel = "";
    if (to.trim()) {
      const tgt = bus.resolveTargets(members, me.id, to);
      if (tgt.error) return `error: ${tgt.error}`;
      ids = tgt.ids;
      targetLabel = to.trim();
    } else {
      ids = others.map((m: any) => m.id);
      targetLabel = "all members";
    }
    const allNames = ids.map((id: string) => members[id]?.name).filter(Boolean);
    if (!allNames.length) return "error: no valid targets (everyone may be offline — try team revive).";
    await bus.sendMessage(root, me.team, {
      type: "dm",
      from: me.id,
      fromName: me.name,
      fromRole: me.role,
      to: targetLabel, // recorded in the audit log so replies classify as replies (airtight wake)
      subject: "status check",
      body: question,
      targets: ids,
      wake: true,
    });
    // Progress tracks the reachable targets; offline members get the DM queued
    // but don't block the checkin from completing.
    const progressNames = allNames.filter((n) => others.some((m: any) => m.name === n));
    await bus.setCheckin(root, me.team, me.id, { question, targets: progressNames });
    const offline = Object.entries(members)
      .filter(([id, m]: [string, any]) => m && id !== me.id && m.status === "offline")
      .map(([, m]: [string, any]) => m.name);
    const warn =
      offline.length && !to.trim()
        ? ` Offline (DM queued, not counted): ${offline.join(", ")} — team revive to wake them.`
        : "";
    return `Checkin sent to ${targetLabel} (${allNames.length}; wake: YES). Non-blocking: end this turn — each reply auto-wakes me with progress and I summarize when all have replied. Do NOT sleep or poll the inbox.${warn}`;
  }

  // Locate a versioned team definition: teams/<Name>.json next to the
  // extension, in the standard install dir, or in the cwd.
  function findTeamDef(name: string): string | null {
    const want = name.toLowerCase();
    const candidates = [];
    try {
      const here = path.dirname(new URL(import.meta.url).pathname);
      candidates.push(path.join(here, "teams"), path.join(here, "..", "pi-team", "teams"));
    } catch { /* jiti may rewrite import.meta.url */ }
    candidates.push(path.join(process.env.HOME || "/tmp", ".pi", "agent", "extensions", "pi-team", "teams"));
    if (process.cwd()) candidates.push(path.join(process.cwd(), "teams"));
    for (const dir of candidates) {
      try {
        const entries = fs.readdirSync(dir);
        const hit = entries.find((e) => e.toLowerCase() === `${want}.json` || e.toLowerCase() === want);
        if (hit) return path.join(dir, hit.endsWith(".json") ? hit : `${hit}.json`);
      } catch { /* next candidate */ }
    }
    return null;
  }

  // Per-project task board: <cwd>/agent-team when present, else team board.
  async function taskStore(me: NonNullable<Awaited<ReturnType<typeof myTeam>>>, c: ExtensionContext) {
    return bus.resolveTaskStore(me.root, me.team, c?.cwd);
  }

  function checkinProgressLine(rec: any): string {
    if (!rec || !rec.targets?.length) return "";
    const missing = rec.targets.filter((n: string) => !rec.replied.includes(n));
    if (missing.length === 0) {
      return `\n[team-checkin] ALL ${rec.targets.length} members replied to your checkin ("${rec.question}") — produce the final status summary now.`;
    }
    return `\n[team-checkin] Checkin progress: ${rec.replied.length}/${rec.targets.length} replied. Still waiting on: ${missing.join(", ")}. Replies will wake you — no polling needed.`;
  }

  // -------------------------------------------------------------------------
  // team tool (agent-facing)
  // -------------------------------------------------------------------------

  function formatTask(t: any, tasks: any[]): string {
    const lines = [
      `${t.id} [${t.status}] ${t.title}${t.priority === "high" ? " [high]" : ""}`,
      t.body ? `Description: ${t.body}` : null,
      t.assignee ? `Assignee: ${t.assignee}` : null,
      t.createdByName ? `Created by: ${t.createdByName}` : null,
      t.criteria?.length ? `Acceptance criteria:\n  - ${t.criteria.join("\n  - ")}` : null,
      t.dependsOn?.length
        ? `Depends on: ${t.dependsOn
            .map((d: string) => {
              const dep = tasks.find((x: any) => x.id === d);
              return dep ? `${d} (${dep.status})` : `${d} (missing)`;
            })
            .join(", ")}`
        : null,
      t.evidence ? `Evidence:\n${t.evidence}` : null,
      t.blockedReason ? `Blocked: ${t.blockedReason}` : null,
      t.failReason ? `Failed: ${t.failReason}` : null,
    ].filter(Boolean);
    return lines.join("\n");
  }

  // Shared transition logic for task_start/blocked/fail/done. Returns the
  // result text (with dependency warnings surfaced, and a DM to the creator on
  // completion).
  async function taskTransition(
    me: NonNullable<Awaited<ReturnType<typeof myTeam>>>,
    p: Record<string, any>,
    to: string,
    c: ExtensionContext,
  ): Promise<string> {
    const root = p.dir?.trim() || bus.teamsRoot(process.env);
    const tid = String(p.task_id || "").trim();
    if (!tid) return "error: task_id required (task_id).";
    const store = await taskStore(me, c);
    const res = await bus.updateTask(
      root,
      me.team,
      tid,
      { status: to, reason: p.body, evidence: p.evidence, depOverride: p.dep_override, confidence: p.confidence },
      { id: me.id, name: me.name, role: me.role },
      store.dir,
    );
    if (!res.ok) return `error: ${res.error}`;
    let out = `Task ${tid} -> ${to}.`;
    if (res.warnings?.length) {
      out += `\nWarning — ${res.warnings.join("; ")}.`;
    }
    if (res.bouncedTaskId) {
      out += `\nTask ${res.bouncedTaskId} was bounced back to running (review failed) and its assignee was notified.`;
    }
    if (res.acceptedTaskId) {
      out += `\nTask ${res.acceptedTaskId} accepted (review passed) and its creator was notified.`;
    }
    if (res.lowConfidence) {
      out += `\nLow confidence flagged — the coordinator was notified and research follow-up task ${res.researchTaskId || "(none available)"} was auto-created to shore it up.`;
    }
    if (res.notified) {
      out += ` Notified ${res.notified} recipient(s).`;
    }
    const me2 = await myTeam(c);
    if (me2) await refreshWidget(c, me2, true);
    return out;
  }

  async function handleAction(p: Record<string, any>, c: ExtensionContext, signal?: AbortSignal): Promise<string> {
    const root = p.dir?.trim() || bus.teamsRoot(process.env);
    const me = await myTeam(c);
    const id = safeSessionId(c);
    const notInTeam = "error: you are not in a team. Create one (team create) or join one (team join).";

    switch (p.action) {
      case "create": {
        const team = String(p.team || "").trim();
        if (!team) return "error: team name required (team).";
        const res = await bus.createTeam(root, team, { name: p.name });
        if (!res.ok) return `error: ${res.error}`;
        if (p.role || p.name) {
          const jr = await bus.joinMember(root, team, { id, name: p.name, role: p.role });
          if (!jr.ok) return `error: ${jr.error}`;
          saveSessionIdentity(c, { root, team, name: jr.member.name, role: jr.member.role });
          memberId = id;
          const me2 = await myTeam(c);
          if (me2) {
            startWatcher(me2);
            applyTitle(c, me2);
          }
          return `Team "${team}" ready at ${bus.teamDir(root, team)}. You joined as ${jr.member.name} (${jr.member.role}).\nTeammates join with: team join ${team} --role <their-role> --name <their-name>`;
        }
        return `Team "${team}" created at ${bus.teamDir(root, team)}. Join it with: team join ${team} --name <you> --role <role>`;
      }

      case "join": {
        const team = String(p.team || "").trim();
        if (!team) return "error: team name required (team).";
        const jr = await bus.joinMember(root, team, { id, name: p.name, role: p.role });
        if (!jr.ok) return `error: ${jr.error}`;
        saveSessionIdentity(c, { root, team, name: jr.member.name, role: jr.member.role });
        memberId = id;
        const me2 = await myTeam(c);
        if (me2) {
          startWatcher(me2);
          applyTitle(c, me2);
        }
        const members = await bus.loadMembers(root, team);
        return `Joined team "${team}" as ${jr.member.name} (${jr.member.role}).\n${rosterLine(team, bus.rosterList(members, id))}`;
      }

      case "kick": {
        if (!me) return notInTeam;
        if (!bus.hasRole(me.role, "coordinator")) {
          return "error: only a coordinator can remove members (kick).";
        }
        const name = String(p.to || "").trim();
        if (!name) return "error: to required (the member name to remove).";
        const res = await bus.kickMember(root, me.team, name, {
          byId: me.id,
          byName: me.name,
          reason: String(p.body || "").trim() || undefined,
        });
        if (!res.ok) return `error: ${res.error}`;
        return `Removed ${res.member.name} (${res.member.role}) from team "${me.team}". Their name is free again.`;
      }

      case "leave": {
        if (!me) return notInTeam;
        await bus.leaveMember(root, me.team, me.id);
        stopWatcher();
        try {
          c.ui.setTitle("pi");
        } catch { /* ignore */ }
        return `Left team "${me.team}".`;
      }

      case "roster": {
        if (!me) return notInTeam;
        const members = await bus.loadMembers(root, me.team);
        const now = Date.now();
        const rows = bus
          .rosterList(members, me.id)
          .map((m) => `- ${m.name} (${m.role}) — ${bus.isMemberDead(m, now) ? "offline" : m.status || "idle"}${m.self ? " (you)" : ""}`);
        return `Team "${me.team}" — ${Object.keys(members).length} member(s):\n${rows.join("\n")}`;
      }

      case "whoami": {
        return me
          ? `You are ${me.name} (${me.role}) in team "${me.team}" (team dir: ${me.dir}).`
          : "You are not in a team.";
      }

      case "dm":
      case "broadcast":
      case "task":
      case "report": {
        if (!me) return notInTeam;
        const body = String(p.body || "").trim();
        if (!body) return "error: body required.";
        let targets: string[];
        let toLabel: string;
        const members = await bus.loadMembers(root, me.team);
        if (p.action === "broadcast") {
          targets = Object.keys(members).filter((sid) => sid !== me.id);
          toLabel = "everyone";
        } else {
          const to = p.action === "report" ? p.to || "role:coordinator" : p.to;
          // Cross-team address "TeamName/MemberName" (dm + report only).
          const cross = String(to || "").includes("/") ? await bus.resolveCrossTarget(root, to) : null;
          if (cross && cross.error) return `error: ${cross.error}`;
          if (cross) {
            // Lead-to-lead policy: sender + every target must be a coordinator.
            const policy = bus.crossTeamCheck(me.role, cross.members, cross.ids);
            if (!policy.ok) return `error: ${policy.error}`;
            targets = cross.ids;
            toLabel = `${cross.names.join(", ")} (${cross.team})`;
            // cross-team sends land in BOTH audit logs so the reply rule
            // works across the boundary; wake by default (explicit outreach).
            const sent = await bus.sendMessage(root, cross.team, {
              type: p.action === "report" ? "report" : "dm",
              from: me.id,
              fromName: me.name,
              fromRole: me.role,
              fromTeam: me.team,
              // Recipient NAMES (not the address) so the airtight reply rule
              // matches across the boundary; fromTeam carries the context.
              to: cross.names.join(", "),
              subject: String(p.subject || "").trim() || (p.action === "report" ? "completion report" : ""),
              body,
              priority: "normal",
              wake: p.wake !== false,
              targets: cross.ids,
            }, { members: cross.members, logTeams: [cross.team, me.team] });
            if (!sent.ok) return `error: ${sent.error}`;
            return `Cross-team ${p.action === "report" ? "report" : "dm"} sent to ${toLabel} — wake: ${sent.wake ? "YES" : "NO"}. (Their watcher will wake them; replies route back to you.)`;
          }
          const res = bus.resolveTargets(members, me.id, to);
          if (res.error) return `error: ${res.error}`;
          targets = res.ids;
          toLabel = to;
        }
        if (!targets.length) return "error: no recipients available.";
        const type = p.action === "task" ? "task" : p.action === "report" ? "report" : p.action === "broadcast" ? "broadcast" : "dm";
        const subject =
          String(p.subject || "").trim() ||
          (type === "task" ? "task assignment" : type === "report" ? "completion report" : "");
        // Reports always wake the recipient: the coordinator is waiting on them.
        const wake = p.action === "report" ? true : p.wake === true;
        const sent = await bus.sendMessage(root, me.team, {
          type,
          from: me.id,
          fromName: me.name,
          fromRole: me.role,
          to: toLabel,
          subject,
          body,
          priority: type === "task" ? "high" : "normal",
          wake,
          targets,
        });
        if (!sent.ok) return `error: ${sent.error}`;
        let out = `Sent ${type} to ${toLabel} (${sent.delivered} recipient${sent.delivered > 1 ? "s" : ""}) — wake: ${sent.wake ? "YES" : "NO"}.`;
        if (sent.offlineTargets?.length) {
          out += `\nWarning: ${sent.offlineTargets.map((t: any) => t.name).join(", ")} ${sent.offlineTargets.length > 1 ? "appear" : "appears"} offline — the message is queued and will surface on their next turn; use dm --wake or team revive to reach them now.`;
        }
        return out;
      }

      case "inbox": {
        if (!me) return notInTeam;
        const msgs = await bus.drainInbox(root, me.team, me.id);
        if (!msgs.length) return "Inbox empty.";
        return formatMessages(msgs);
      }

      case "board_write": {
        if (!me) return notInTeam;
        const topic = String(p.topic || "").trim();
        if (!topic) return "error: topic required for board_write.";
        const store = await taskStore(me, c);
        const res = await bus.writeBoard(root, me.team, topic, p.body, store.dir);
        return res.ok ? `Board "${topic}" updated${store.kind === "project" ? ` (project board ${store.dir})` : ""}.` : `error: ${res.error}`;
      }

      case "board_read": {
        if (!me) return notInTeam;
        const store = await taskStore(me, c);
        const res = await bus.readBoard(root, me.team, p.topic, store.dir);
        if (!res.ok) return `error: ${res.error}`;
        if (p.topic) return `# ${res.topic}\n\n${res.content}`;
        return `Board topics: ${res.topics.length ? res.topics.join(", ") : "(empty)"}${store.kind === "project" ? ` (project board ${store.dir})` : ""}`;
      }

      // ---- task board (structured tasks; done requires evidence) ----

      case "task_create": {
        if (!me) return notInTeam;
        const title = String(p.subject || "").trim();
        if (!title) return "error: task title required (subject).";
        const criteria = Array.isArray(p.criteria)
          ? p.criteria.map(String)
          : String(p.criteria || "").split(/\n|;/).map((s) => s.trim()).filter(Boolean);
        const dependsOn = Array.isArray(p.depends_on) ? p.depends_on.map(String) : [];
        const assignee = p.to ? String(p.to).trim() : null;
        const store = await taskStore(me, c);
        const res = await bus.createTask(root, me.team, {
          title,
          body: p.body,
          assignee,
          criteria,
          dependsOn,
          priority: p.priority,
          kind: p.kind,
          reviewOf: p.review_of,
          createdBy: me.id,
          createdByName: me.name,
        }, store.dir);
        if (!res.ok) return `error: ${res.error}`;
        let out = `Created task ${res.task.id} [${res.task.status}]${res.task.kind === "review" ? " (review)" : ""}: ${title}${assignee ? ` -> ${assignee}` : ""}.`;
        if (res.notified) out += ` Notified ${res.notified} assignee(s).`;
        if (res.warnings?.length) out += `\nWarning: ${res.warnings.join("; ")}`;
        await refreshWidget(c, me, true);
        return out;
      }

      case "task_list": {
        if (!me) return notInTeam;
        const store = await taskStore(me, c);
        const tasks = await bus.loadTasks(root, me.team, store.dir);
        if (!tasks.length) return `Task board empty${store.kind === "project" ? ` (project ${store.dir})` : ""}. Create tasks with team task_create.`;
        return tasks
          .map((t: any) => `[${t.status}] ${t.id} — ${t.title}${t.assignee ? ` (-> ${t.assignee})` : ""}`)
          .join("\n");
      }

      case "task_show": {
        if (!me) return notInTeam;
        const tid = String(p.task_id || "").trim();
        if (!tid) return "error: task_id required.";
        const store = await taskStore(me, c);
        const tasks = await bus.loadTasks(root, me.team, store.dir);
        const t = tasks.find((x: any) => x.id === tid);
        if (!t) return `error: unknown task "${tid}"`;
        return formatTask(t, tasks);
      }

      case "task_start":
        return taskTransition(me, p, "running", c);
      case "task_blocked":
        return taskTransition(me, p, "blocked", c);
      case "task_fail":
        return taskTransition(me, p, "failed", c);
      case "task_done":
        return taskTransition(me, p, "done", c);

      case "task_assign": {
        if (!me) return notInTeam;
        const tid = String(p.task_id || "").trim();
        if (!tid) return "error: task_id required.";
        if (!p.to) return "error: to required (new assignee name or role:<role>).";
        const store = await taskStore(me, c);
        const res = await bus.updateTask(
          root,
          me.team,
          tid,
          { assignee: String(p.to).trim() },
          { id: me.id, name: me.name, role: me.role },
          store.dir,
        );
        if (!res.ok) return `error: ${res.error}`;
        return `Task ${tid} reassigned to ${res.task.assignee}.`;
      }

      case "status": {
        if (!me) return notInTeam;
        await bus.touchMember(root, me.team, me.id, {
          status: String(p.status || "").trim() || "idle",
        });
        return "Status updated.";
      }

      case "set_role": {
        if (!me) return notInTeam;
        if (!p.role) return "error: role required for set_role.";
        const res = await bus.setMemberRole(root, me.team, me.id, p.role);
        if (!res.ok) return `error: ${res.error}`;
        saveSessionIdentity(c, { root, team: me.team, name: me.name, role: res.member.role });
        return `Role updated to ${res.member.role}.`;
      }

      case "preset_create": {
        if (!me) return notInTeam;
        const roster = Array.isArray(p.preset) ? p.preset : [];
        if (!roster.length) return "error: preset required (array of {name, role}).";
        await bus.savePreset(
          root,
          me.team,
          roster.map((r: any) => ({ name: String(r.name || "").trim(), role: String(r.role || "agent").trim() })),
        );
        return `Preset for "${me.team}" set (${roster.length} member(s)). Revive it with team revive.`;
      }

      case "memo": {
        if (!me) return notInTeam;
        const body = String(p.body || "").trim();
        if (!body) return "error: body required (what to remember).";
        const res = await bus.memoAppend(c.cwd, { team: me.team, name: me.name, role: me.role, body });
        return res.ok ? `Recorded in ${res.file}.` : `error: ${res.error || "could not write"}`;
      }

      case "briefing": {
        if (!me) return notInTeam;
        if (p.body !== undefined && String(p.body).trim()) {
          if (!bus.hasRole(me.role, "coordinator")) {
            return "error: only a coordinator can set the team briefing (team briefing --body \"...\"). Anyone can read it.";
          }
          await bus.saveBrief(root, me.team, String(p.body).trim());
          return `Team briefing updated. It is injected into every member's next turn.`;
        }
        const brief = await bus.loadBrief(root, me.team);
        const members = await bus.loadMembers(root, me.team);
        return buildBriefing(me, members, brief);
      }

      case "later": {
        if (!me) return notInTeam;
        const res = await bus.setTimer(root, me.team, me.id, {
          minutes: p.minutes,
          at: String(p.at || "").trim() || undefined,
          body: String(p.body || "").trim(),
        });
        if (!res.ok) return `error: ${res.error}`;
        const d = new Date(res.timer.dueAt);
        await armTimers(me);
        return `Timer set: the harness will ping you at ${d.toTimeString().slice(0, 5)} (in ${Math.max(1, Math.round((res.timer.dueAt - Date.now()) / 60000))} min) — "${res.timer.body || "ping"}". Continue your current work; you will be woken.`;
      }

      case "timers": {
        if (!me) return notInTeam;
        const list = await bus.listTimers(root, me.team, me.id);
        if (!list.length) return "No timers set. Use team later --minutes N --body \"...\" to have the harness ping you.";
        return list
          .map((t: any) => `${t.id} @ ${new Date(t.dueAt).toTimeString().slice(0, 5)} — ${t.body || "(no note)"}`)
          .join("\n");
      }

      case "search": {
        if (!me) return notInTeam;
        const meta = await bus.loadTeam(root, me.team).catch(() => null);
        const res = await bus.searchWeb(String(p.query || ""), {
          count: p.count,
          categories: String(p.categories || "").trim() || undefined,
          teamMeta: meta,
        });
        if (!res.ok) return `error: ${res.error}`;
        const lines = [`Search results (${res.count}) via ${res.base}:`];
        for (const r of res.results) {
          lines.push(`- ${r.title}\n  ${r.url}${r.snippet ? `\n  ${r.snippet}` : ""}`);
        }
        return lines.join("\n");
      }

      case "clear": {
        if (!me) return notInTeam;
        if (!bus.hasRole(me.role, "coordinator")) return "error: only a coordinator can clear the team board.";
        const store = await taskStore(me, c);
        const res = await bus.clearBoard(root, me.team, { clearTopics: p.board === true || p.all === true }, store.dir);
        if (!res.ok) return `error: ${res.error}`;
        return `Board cleared: archived ${res.archived} task${res.archived === 1 ? "" : "s"} (${res.done} done) to ${res.archive}${res.topicsCleared ? `; cleared ${res.topicsCleared} board topic(s)` : ""}. ${store.kind === "project" ? `Project board (${store.dir})` : `Team "${me.team}"`} is ready for a new project.`;
      }

      case "export": {
        if (!me) return notInTeam;
        const name = String(p.team || me.team || "").trim();
        if (!name) return "error: team name required (team).";
        const res = await bus.exportTeam(root, name, p.file || undefined);
        if (!res.ok) return `error: ${res.error}`;
        return `Exported team "${name}" (${res.members} preset members) to ${res.file} — commit it to share with other machines.`;
      }

      case "import": {
        const name = String(p.team || "").trim();
        if (!name) return "error: team name required (team).";
        const def = p.file || findTeamDef(name);
        if (!def) return `error: no team definition for "${name}" in the repo teams/ dir.`;
        const res = await bus.importTeam(root, def);
        if (!res.ok) return `error: ${res.error}`;
        return `Imported team "${res.name}" (${res.members} preset members) from ${def}. Join with: team join ${res.name} --name <you> --role <role>, or relaunch: pi --team ${res.name}.`;
      }

      case "checkin": {
        if (!me) return notInTeam;
        return await checkinMembers(me, { to: String(p.to || ""), body: String(p.body || "") });
      }

      case "await_members": {
        if (!me) return notInTeam;
        const to = String(p.to || "").trim();
        if (!to) return "error: to required (member name or role:<role>).";
        const members = await bus.loadMembers(root, me.team);
        const tgt = bus.resolveTargets(members, me.id, to);
        if (tgt.error) return `error: ${tgt.error}`;
        const names = tgt.ids.map((id: string) => members[id]?.name).filter(Boolean);
        if (!names.length) return "error: no valid targets.";
        const timeoutMs = Math.max(1, Math.min(p.timeout_minutes || 3, 30)) * 60_000;
        const res = await bus.awaitReplies(root, me.team, me.id, names, {
          mode: p.mode === "any" ? "any" : "all",
          timeoutMs,
          signal,
        });
        const lines = [`Awaited ${names.join(", ")} (${(res.elapsedMs / 1000).toFixed(0)}s):`];
        for (const { name, msgs } of res.replied) {
          lines.push(`- ${name}: ${msgs.map((m: any) => m.subject || m.body || "(reply)").join(" | ")}`);
        }
        if (res.missing.length) {
          lines.push(`No reply (timeout): ${res.missing.join(", ")}.`);
        }
        return lines.join("\n");
      }

      case "config": {
        if (!me) return notInTeam;
        if (p.auto_respond !== undefined) {
          if (!bus.hasRole(me.role, "coordinator")) {
            return "error: only a coordinator can change team settings.";
          }
          const res = await bus.setTeamSetting(root, me.team, { autoRespond: p.auto_respond === true });
          return `autoRespond is now ${res.team.autoRespond ? "ON" : "OFF"} (default ON). When ON, idle members auto-start a turn for any new message (rate-limited ~3/min); set false if you want to read messages only on your own prompt.`;
        }
        if (p.auto_timers !== undefined) {
          if (!bus.hasRole(me.role, "coordinator")) {
            return "error: only a coordinator can change team settings.";
          }
          // Format: "Zed:15:run the next cycle;Daisy:30:scout scan"
          const parsed = String(p.auto_timers)
            .split(";")
            .map((pair) => pair.trim())
            .filter(Boolean)
            .map((pair) => {
              const m = pair.match(/^([^:]+):(\d+):(.*)$/);
              return m ? { name: m[1].trim(), minutes: Number(m[2]), body: m[3].trim(), tag: m[1].trim().toLowerCase() } : null;
            })
            .filter(Boolean);
          if (!parsed.length) return "error: bad auto_timers format (use \"Name:minutes:body;Name2:30:body2\").";
          const res = await bus.setTeamSetting(root, me.team, { autoTimers: parsed });
          await armAutoTimers(me);
          await armTimers(me);
          return `Standing timers set for ${parsed.map((a) => a.name).join(", ")} — they auto-arm at session start and re-arm after each fire.`;
        }
        const meta = await bus.loadTeam(root, me.team);
        return `Team "${me.team}" — autoRespond: ${meta?.autoRespond} | interject: ${meta?.interject}. Set with team config --auto_respond true|false.`;
      }

      case "preset_show": {
        if (!me) return notInTeam;
        const preset = await bus.loadPreset(root, me.team);
        if (!preset?.members?.length) {
          return "No preset for this team. Members are added to the preset automatically when they join (name + role); it survives crashes and power loss.";
        }
        return `Team preset "${me.team}" (${preset.members.length} member(s)):\n${preset.members.map((m) => `- ${m.name} (${m.role})`).join("\n")}\n\nRevive it with team revive, or refresh with team preset_save.`;
      }

      case "preset_save": {
        if (!me) return notInTeam;
        await bus.refreshPresetFromRoster(root, me.team);
        return "Preset refreshed from the current roster.";
      }

      case "revive": {
        if (!me) return notInTeam;
        const preset = await bus.loadPreset(root, me.team);
        if (!preset?.members?.length) return "error: no preset for this team (members are added on join).";
        const members = await bus.loadMembers(root, me.team);
        const now = Date.now();
        const spawned: string[] = [];
        const skipped: string[] = [];
        for (const m of preset.members) {
          const live = Object.values(members).some(
            (x: any) => x.name === m.name && x.status !== "offline" && now - (x.lastSeen || 0) < bus.STALE_MEMBER_MS,
          );
          if (live) {
            skipped.push(m.name);
            continue;
          }
          await spawnWorker(me, { role: m.role, name: m.name, prompt: p.prompt }, c);
          spawned.push(m.name);
        }
        return (
          `Reviving team "${me.team}"...\nSpawned: ${spawned.join(", ") || "(none)"}\n` +
          `Already live (skipped): ${skipped.join(", ") || "(none)"}\n` +
          `Each spawns with PI_TEAM=${me.team} and auto-joins with its preset name/role.`
        );
      }

      case "spawn": {
        if (!me) return notInTeam;
        return spawnWorker(me, p, c);
      }

      case "selftest":
        return runSelftest();

      default:
        return `error: unknown action "${p.action}". Actions: ${ACTIONS.join(", ")}`;
    }
  }

  pi.registerTool({
    name: "team",
    label: "Team",
    description:
      "Coordinate with other pi agents in your team (like a company): join teams, DM teammates, assign tasks, post reports, share a board, and track a structured task board. Actions: create, join, leave, roster, dm, broadcast, task, report, inbox, board_write, board_read, status, whoami, set_role, spawn, selftest, task_create, task_list, task_show, task_start, task_done, task_blocked, task_fail, task_assign, preset_show, preset_save, preset_create, revive, briefing (read, or set the team mission as coordinator), memo (append to MEMORY.md project memory in the working directory), checkin (NON-BLOCKING status check: wake-DM everyone and end your turn — replies auto-wake you with progress, no sleeping/polling; use this for any 'what is everyone doing' question), await_members (BLOCKING wait: pass ALL member names at once comma-separated to wait until every one replies or the timeout — never call it once per member), later (set a self-ping timer: the harness wakes you with a turn at the given time — team later --minutes 30 --body '...' or --at HH:MM; timers persist across restarts and fire on next start if missed; list with team timers, cancel with team later --cancel <id>), search (web search via the local SearXNG instance — team search 'query' [--count N] [--categories news]; available to every team, override the URL with team config --search_url <url>). Address recipients by member name or role:<role> (e.g. role:implementer). Reports go to role:coordinator by default. Tasks live on the team board; completing one REQUIRES evidence, is blocked on unfinished dependencies unless dep_override, and kind=review tasks gate a reviewed task (failure bounces it back to running).",
    promptSnippet: "Coordinate with teammate pi agents via team: DM, assign tasks, post reports, share a board, track tasks",
    promptGuidelines: [
      "Use team when the user wants multiple agents to work together or you need help from a teammate.",
      "Use team task with role:<role> or a member name to assign work; always include a subject and body.",
      "Prefer team task_create for anything with multiple steps: it records the task on the team board with status, acceptance criteria, and evidence. team task is the lightweight DM version.",
      "Use team task_create with kind=review and review_of=<task id> to add an independent review gate: the reviewer passes with task_done --evidence or bounces the work back with task_fail --body '<issues>'.",
      "Use team task_done with task_id and evidence (what changed, file refs, validation) to complete a board task — evidence is required and unfinished dependencies block completion unless you pass dep_override with a reason.",
      "Use team report to send your completion report to role:coordinator after finishing assigned work (reports wake the coordinator automatically).",
      "If you intend to wake idle recipients, you MUST pass wake:true on the dm/task call — the tool result echoes whether wake was applied.",
      "For status checks use team checkin (to=..., body=...) — it is NON-BLOCKING: it wake-DMs everyone and you END YOUR TURN; each reply auto-wakes you with progress and you summarize when all have replied. NEVER use sleep or manual inbox polling to wait for team replies. Only when you truly must block in one turn, use team await_members passing ALL names at once (to='A, B, C', timeout_minutes=N) — one call waits for all of them; never call it once per member.",
      "Use team roster to see teammates and roles; use team inbox to check for new messages mid-turn.",
      "Every turn starts with a [team-context] briefing: your role, the mission, who to report to (role:coordinator), where completed work goes (role:reviewer), and the team protocol. Follow it.",
      "If your work crosses another member's scope, DM them directly to coordinate.",
      "If you need research or feel uncertain about anything, DM role:researcher to investigate before proceeding.",
      "Use team board_write/board_read for shared design notes instead of long DMs.",
    ],
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      team: Type.Optional(Type.String({ description: "Team name (required for create/join)." })),
      role: Type.Optional(Type.String({ description: "Role for create/join/set_role/spawn, e.g. coordinator, architect, implementer, reviewer." })),
      name: Type.Optional(Type.String({ description: "Your friendly member name (unique in team) for create/join/spawn." })),
      to: Type.Optional(Type.String({ description: "Recipient for dm/task/report: a member name or role:<role>." })),
      subject: Type.Optional(Type.String({ description: "Short subject (required for tasks)." })),
      body: Type.Optional(Type.String({ description: "Message body for dm/broadcast/task/report; board content for board_write." })),
      topic: Type.Optional(Type.String({ description: "Board topic for board_write/board_read." })),
      task_id: Type.Optional(Type.String({ description: "Task id for task_show/task_start/task_done/task_blocked/task_fail/task_assign." })),
      criteria: Type.Optional(Type.Array(Type.String(), { description: "Acceptance criteria for task_create (array or newline/;-separated text)." })),
      evidence: Type.Optional(Type.String({ description: "Required for task_done: what changed (file refs), validation run." })),
      depends_on: Type.Optional(Type.Array(Type.String(), { description: "Task ids this task depends on (task_create)." })),
      dep_override: Type.Optional(Type.String({ description: "Reason to complete a task despite unfinished dependencies (task_done)." })),
      confidence: Type.Optional(Type.String({ description: "Optional self-reported confidence for task_done: low|medium|high (or a score like 0.8 / 70%). LOW auto-notifies the coordinator and creates a research follow-up task." })),
      kind: Type.Optional(StringEnum(["work", "review"] as const)),
      review_of: Type.Optional(Type.String({ description: "For kind=review: the task id being reviewed. Failing the review bounces it back to running." })),
      priority: Type.Optional(StringEnum(["normal", "high"] as const)),
      status: Type.Optional(Type.String({ description: "Status text for the status action (e.g. blocked on parser)." })),
      prompt: Type.Optional(Type.String({ description: "Kickoff prompt for the spawn action." })),
      wake: Type.Optional(Type.Boolean({ description: "Wake the recipient(s) on dm/broadcast/task/report: an idle member starts a turn to act on it now (rate-limited). Use for urgent or status-check messages." })),
      auto_respond: Type.Optional(Type.Boolean({ description: "For config: set team autoRespond (coordinator only)." })),
      minutes: Type.Optional(Type.Number({ description: "For later: ping me in this many minutes." })),
      at: Type.Optional(Type.String({ description: "For later: ping me at this 24h time (HH:MM, e.g. 14:30)." })),
      cancel: Type.Optional(Type.String({ description: "For later: cancel a timer by id." })),
      all: Type.Optional(Type.Boolean({ description: "For clear (coordinator): also wipe board topics, not just tasks." })),
      board: Type.Optional(Type.Boolean({ description: "For clear (coordinator): also wipe board topics." })),
      auto_timers: Type.Optional(Type.String({ description: "For config (coordinator): standing cadence timers 'Name:minutes:body;Name2:30:body2' — auto-armed at session start, re-armed after each fire." })),
      query: Type.Optional(Type.String({ description: "For search: the web query (SearXNG, local)." })),
      file: Type.Optional(Type.String({ description: "For export/import: path to the team definition file." })),
      count: Type.Optional(Type.Number({ description: "For search: max results (1-10, default 6)." })),
      categories: Type.Optional(Type.String({ description: "For search: SearXNG categories, e.g. 'news,general'." })),
      timeout_minutes: Type.Optional(Type.Number({ description: "For await_members: max minutes to wait (1-30, default 3)." })),
      mode: Type.Optional(StringEnum(["all", "any"] as const)),
      preset: Type.Optional(Type.Array(Type.Object({ name: Type.String(), role: Type.Optional(Type.String()) }), { description: "For preset_create: the roster, e.g. [{name:'Optimus', role:'coordinator, reviewer'}, ...]. Roles may be comma-separated." })),
      dir: Type.Optional(Type.String({ description: "Team root directory override (default ~/.pi/teams)." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, c) {
      const text = await handleAction(params as Record<string, any>, c, signal).catch((e: any) => {
        return `team error: ${e?.message ?? e}`;
      });
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // -------------------------------------------------------------------------
  // /team command (user-facing)
  // -------------------------------------------------------------------------

  // Quote-aware tokenizer so `--role "coordinator, reviewer"` stays one value.
  function parseArgs(input: string): Record<string, string> & { _: string[] } {
    const out: Record<string, string> & { _: string[] } = { _: [] };
    const tokens: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input.trim()))) {
      tokens.push(m[1] ?? m[2] ?? m[3]);
    }
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith("--")) {
        const eq = t.indexOf("=");
        if (eq > 0) {
          out[t.slice(2, eq)] = t.slice(eq + 1);
        } else {
          const key = t.slice(2);
          const next = tokens[i + 1];
          if (next && !next.startsWith("--")) {
            out[key] = next;
            i++;
          } else {
            out[key] = "true";
          }
        }
      } else {
        out._.push(t);
      }
    }
    return out;
  }

  pi.registerCommand("team", {
    description:
      "Manage your agent team: create/join/leave, roster, inbox, set-role, config, selftest. Usage: /team <create|join|leave|roster|inbox|set-role|set-name|config|selftest|help> [args]",
    handler: async (args, c) => {
      const argv = parseArgs(args);
      const sub = argv._[0] || "help";
      const root = argv.dir?.trim() || bus.teamsRoot(process.env);
      const id = safeSessionId(c);
      const notify = (msg: string) => {
        if (c.hasUI) c.ui.notify(msg, "info");
      };
      try {
        switch (sub) {
          case "create": {
            const team = argv._[1];
            if (!team) return notify("Usage: /team create <name> [--name You] [--role R] [--dir PATH]");
            const res = await bus.createTeam(root, team, { name: argv.name });
            if (!res.ok) return notify(`error: ${res.error}`);
            if (argv.name || argv.role) {
              const jr = await bus.joinMember(root, team, { id, name: argv.name, role: argv.role });
              if (!jr.ok) return notify(`error: ${jr.error}`);
              saveSessionIdentity(c, { root, team, name: jr.member.name, role: jr.member.role });
              memberId = id;
              const me = await myTeam(c);
              if (me) {
                startWatcher(me);
                applyTitle(c, me);
              }
              return notify(`Team "${team}" created. You joined as ${jr.member.name} (${jr.member.role}).`);
            }
            return notify(`Team "${team}" created at ${bus.teamDir(root, team)}.`);
          }
          case "join": {
            const team = argv._[1];
            if (!team) return notify("Usage: /team join <name> [--name You] [--role R] [--dir PATH]");
            const jr = await bus.joinMember(root, team, { id, name: argv.name, role: argv.role });
            if (!jr.ok) return notify(`error: ${jr.error}`);
            saveSessionIdentity(c, { root, team, name: jr.member.name, role: jr.member.role });
            memberId = id;
            const me = await myTeam(c);
            if (me) {
              startWatcher(me);
              applyTitle(c, me);
            }
            return notify(`Joined "${team}" as ${jr.member.name} (${jr.member.role}).`);
          }
          case "kick": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            if (!bus.hasRole(me.role, "coordinator")) return notify("Only a coordinator can remove members (kick).");
            const name = argv._[1];
            if (!name) return notify("Usage: /team kick <name> [reason...]");
            const reason = argv._.slice(2).join(" ") || argv.body || undefined;
            const res = await bus.kickMember(root, me.team, name, { byId: me.id, byName: me.name, reason });
            if (!res.ok) return notify(`error: ${res.error}`);
            return notify(`Removed ${res.member.name} (${res.member.role}) from "${me.team}". Name is free again.`);
          }
          case "search": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            const q = argv._.slice(1).join(" ") || argv.q;
            if (!q) return notify("Usage: /team search <query> [--count N] [--categories news]");
            const meta = await bus.loadTeam(root, me.team).catch(() => null);
            const res = await bus.searchWeb(q, {
              count: parseFloat(argv.count || "6"),
              categories: argv.categories || undefined,
              teamMeta: meta,
            });
            if (!res.ok) return notify(`error: ${res.error}`);
            return notify(
              `Search (${res.count}) via ${res.base}:\n` +
                res.results.map((r: any) => `- ${r.title}\n  ${r.url}\n  ${r.snippet}`).join("\n"),
            );
          }
          case "later": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            if (argv.cancel) {
              const res = await bus.cancelTimer(root, me.team, me.id, argv.cancel);
              return notify(res.ok ? `Cancelled timer ${argv.cancel}.` : `error: ${res.error}`);
            }
            const mins = parseFloat(argv.minutes || argv._[1] || "");
            const body = argv.body || argv._.slice(2).join(" ") || "";
            const res = await bus.setTimer(root, me.team, me.id, {
              minutes: Number.isFinite(mins) ? mins : undefined,
              at: argv.at || undefined,
              body,
            });
            if (!res.ok) return notify(`error: ${res.error}`);
            await armTimers(me);
            return notify(`Timer set: ping at ${new Date(res.timer.dueAt).toTimeString().slice(0, 5)} — "${res.timer.body || "ping"}". The harness will wake you.`);
          }
          case "timers": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            const list = await bus.listTimers(root, me.team, me.id);
            return notify(
              list.length
                ? list.map((t: any) => `${t.id} @ ${new Date(t.dueAt).toTimeString().slice(0, 5)} — ${t.body || ""}`).join("\n")
                : "No timers set. Use /team later <minutes> --body \"...\" to have the harness ping you.",
            );
          }
          case "clear": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            if (!bus.hasRole(me.role, "coordinator")) return notify("Only a coordinator can clear the team board.");
            const store = await taskStore(me, c);
            const res = await bus.clearBoard(root, me.team, { clearTopics: argv.all === "true" || argv.board === "true" }, store.dir);
            if (!res.ok) return notify(`error: ${res.error}`);
            return notify(`Board cleared: archived ${res.archived} task${res.archived === 1 ? "" : "s"} (${res.done} done) to ${res.archive}${res.topicsCleared ? `; cleared ${res.topicsCleared} board topic(s)` : ""}. ${store.kind === "project" ? `Project board (${store.dir})` : `Team "${me.team}"`} is ready for a new project.`);
          }
          case "export": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            const name = argv._[1] || me.team;
            const res = await bus.exportTeam(root, name, argv.file || undefined);
            if (!res.ok) return notify(`error: ${res.error}`);
            return notify(`Exported team "${name}" (${res.members} preset members) to ${res.file}. Commit it to share.`);
          }
          case "import": {
            const name = argv._[1];
            if (!name) return notify("Usage: /team import <TeamName> [--file <path>]");
            const def = argv.file || findTeamDef(name);
            if (!def) return notify(`error: no team definition for "${name}" in the repo teams/ dir.`);
            const res = await bus.importTeam(root, def);
            if (!res.ok) return notify(`error: ${res.error}`);
            return notify(`Imported team "${res.name}" (${res.members} preset members) from ${def}.`);
          }
          case "checkin": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            const names = argv._.slice(1);
            const body = argv.body || (names.length ? "" : undefined);
            return notify(await checkinMembers(me, { to: names.join(", "), body: body || "" }));
          }
          case "leave": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            await bus.leaveMember(root, me.team, me.id);
            stopWatcher();
            return notify(`Left team "${me.team}".`);
          }
          case "roster": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            const members = await bus.loadMembers(root, me.team);
            const rows = bus
              .rosterList(members, me.id)
              .map((m) => `- ${m.name} (${m.role}) — ${m.status || "idle"}${m.self ? " (you)" : ""}`);
            return notify(`Team "${me.team}":\n${rows.join("\n")}`);
          }
          case "tasks": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            const store = await taskStore(me, c);
            const tasks = await bus.loadTasks(root, me.team, store.dir);
            if (!tasks.length) return notify(`Task board empty${store.kind === "project" ? ` (project ${store.dir})` : ""}.`);
            return notify(
              tasks
                .map((t: any) => `[${t.status}] ${t.id} — ${t.title}${t.kind === "review" ? " (review)" : ""}${t.assignee ? ` (-> ${t.assignee})` : ""}`)
                .join("\n"),
            );
          }
          case "prune": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            const hours = parseFloat(argv.hours || argv._[1] || "24");
            // --hours 0 reaps dead sessions immediately (heartbeat gone / offline),
            // safe because live members heartbeat every 60s.
            const olderThanMs = hours > 0 ? hours * 3_600_000 : 3 * 60_000;
            const res = await bus.pruneMembers(root, me.team, { olderThanMs });
            return notify(`Pruned ${res.removed} member(s) last seen more than ${hours > 0 ? hours + "h" : "3 min (dead)"} ago.`);
          }
          case "memo": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            const body = argv._.slice(1).join(" ") || argv.body;
            if (!body) return notify("Usage: /team memo <what to remember>");
            const res = await bus.memoAppend(c.cwd, { team: me.team, name: me.name, role: me.role, body });
            return notify(`Recorded in ${res.file}.`);
          }
          case "await": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            const to = argv._.slice(1).join(" ") || argv.to;
            if (!to) return notify("Usage: /team await <name|role:...> [--minutes N] [--any]");
            const members = await bus.loadMembers(root, me.team);
            const tgt = bus.resolveTargets(members, me.id, to);
            if (tgt.error) return notify(`error: ${tgt.error}`);
            const names = tgt.ids.map((id: string) => members[id]?.name).filter(Boolean);
            const timeoutMs = Math.max(1, Math.min(parseFloat(argv.minutes || "3") || 3, 30)) * 60_000;
            const res = await bus.awaitReplies(root, me.team, me.id, names, {
              mode: argv.any ? "any" : "all",
              timeoutMs,
            });
            const lines = [`Awaited ${names.join(", ")} (${(res.elapsedMs / 1000).toFixed(0)}s):`];
            for (const { name, msgs } of res.replied) {
              lines.push(`- ${name}: ${msgs.map((m: any) => m.subject || m.body || "(reply)").join(" | ")}`);
            }
            if (res.missing.length) lines.push(`No reply (timeout): ${res.missing.join(", ")}.`);
            return notify(lines.join("\n"));
          }
          case "briefing": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            if (argv.body) {
              if (!bus.hasRole(me.role, "coordinator")) return notify("Only a coordinator can set the team briefing.");
              await bus.saveBrief(root, me.team, argv.body);
              return notify("Team briefing updated — injected into every member's next turn.");
            }
            const brief = await bus.loadBrief(root, me.team);
            const members = await bus.loadMembers(root, me.team);
            return notify(buildBriefing(me, members, brief));
          }
          case "preset": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            const sub = argv._[1] || "show";
            if (sub === "save") {
              await bus.refreshPresetFromRoster(root, me.team);
              return notify("Preset refreshed from the current roster.");
            }
            if (sub === "create") {
              // /team preset create Name=role Name=role ...
              const pairs = argv._.slice(2);
              if (!pairs.length) return notify("Usage: /team preset create Name=role [Name=role ...] (roles may be comma-separated)");
              const roster = pairs.map((pair) => {
                const [name, ...rest] = pair.split("=");
                return { name: name.trim(), role: (rest.join("=") || "agent").trim() };
              });
              if (roster.some((r) => !r.name)) return notify("Each entry needs a name: /team preset create Optimus=coordinator, reviewer Bee=implementer");
              await bus.savePreset(root, me.team, roster);
              return notify(`Preset for "${me.team}" set (${roster.length} member(s)). Bring them back with /team revive.`);
            }
            const preset = await bus.loadPreset(root, me.team);
            if (!preset?.members?.length) return notify("No preset yet — members are added automatically on join.");
            return notify(
              `Team preset "${me.team}" (${preset.members.length}):\n` +
                preset.members.map((m) => `- ${m.name} (${m.role})`).join("\n") +
                `\n\nBring the team back with /team revive`,
            );
          }
          case "revive": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            const preset = await bus.loadPreset(root, me.team);
            if (!preset?.members?.length) return notify("No preset for this team (members are added on join).");
            const members = await bus.loadMembers(root, me.team);
            const now = Date.now();
            const spawned: string[] = [];
            const skipped: string[] = [];
            for (const m of preset.members) {
              const live = Object.values(members).some(
                (x: any) => x.name === m.name && x.status !== "offline" && now - (x.lastSeen || 0) < bus.STALE_MEMBER_MS,
              );
              if (live) {
                skipped.push(m.name);
                continue;
              }
              await spawnWorker(me, { role: m.role, name: m.name, prompt: argv.prompt }, c);
              spawned.push(m.name);
            }
            return notify(
              `Reviving "${me.team}": spawned ${spawned.join(", ") || "(none)"} · already live: ${skipped.join(", ") || "(none)"}`,
            );
          }
          case "inbox": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            const msgs = await bus.drainInbox(root, me.team, me.id);
            if (!msgs.length) return notify("Inbox empty.");
            return notify(`Inbox (${msgs.length}): ${formatMessages(msgs).slice(0, 600)}`);
          }
          case "set-role": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            const role = argv._[1] || argv.role;
            if (!role) return notify("Usage: /team set-role <role>");
            const res = await bus.setMemberRole(root, me.team, me.id, role);
            if (!res.ok) return notify(`error: ${res.error}`);
            saveSessionIdentity(c, { root, team: me.team, name: me.name, role: res.member.role });
            return notify(`Role updated to ${res.member.role}.`);
          }
          case "set-name": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            const name = argv._[1] || argv.name;
            if (!name) return notify("Usage: /team set-name <name>");
            const jr = await bus.joinMember(root, me.team, { id: me.id, name, role: me.role, rejoin: true });
            if (!jr.ok) return notify(`error: ${jr.error}`);
            saveSessionIdentity(c, { root, team: me.team, name: jr.member.name, role: jr.member.role });
            return notify(`Now known as ${jr.member.name} (${jr.member.role}).`);
          }
          case "config": {
            const me = await myTeam(c);
            if (!me) return notify("You are not in a team.");
            const ar = argv["auto-respond"];
            if (ar !== undefined) {
              if (!bus.hasRole(me.role, "coordinator")) return notify("Only a coordinator can change team settings.");
              const on = ar === "on" || ar === "true" || ar === "1";
              const res = await bus.setTeamSetting(root, me.team, { autoRespond: on });
              return notify(`autoRespond is now ${on ? "ON" : "OFF"} — idle members ${on ? "will" : "won't"} auto-start turns on DMs; wake-marked messages (dm --wake) always wake.`);
            }
            const su = argv["search-url"];
            if (su !== undefined) {
              if (!bus.hasRole(me.role, "coordinator")) return notify("Only a coordinator can change team settings.");
              const res = await bus.setTeamSetting(root, me.team, { searchUrl: su });
              return notify(`SearXNG URL for this team set to "${su}". (Default: env JCODE_SEARXNG_URL / SEARXNG_URL / http://127.0.0.1:8888.)`);
            }
            const at = argv["auto-timers"];
            if (at !== undefined) {
              if (!bus.hasRole(me.role, "coordinator")) return notify("Only a coordinator can change team settings.");
              const parsed = String(at)
                .split(";")
                .map((pair) => pair.trim())
                .filter(Boolean)
                .map((pair) => {
                  const m = pair.match(/^([^:]+):(\d+):(.*)$/);
                  return m ? { name: m[1].trim(), minutes: Number(m[2]), body: m[3].trim(), tag: m[1].trim().toLowerCase() } : null;
                })
                .filter(Boolean);
              if (!parsed.length) return notify("error: bad --auto-timers format (use \"Name:minutes:body;Name2:30:body2\").");
              const res = await bus.setTeamSetting(root, me.team, { autoTimers: parsed });
              await armAutoTimers(me);
              return notify(`Standing timers set for ${parsed.map((a) => a.name).join(", ")} — auto-armed at session start, re-armed after each fire.`);
            }
            const meta = await bus.loadTeam(root, me.team);
            const members = await bus.loadMembers(root, me.team);
            const atList = (meta?.autoTimers || []).map((a: any) => `${a.name}:${a.minutes}m:${a.body.slice(0, 30)}`).join(" | ") || "(none)";
            return notify(
              `Team "${me.team}" @ ${me.dir}\nautoRespond: ${meta?.autoRespond} | interject: ${meta?.interject}\nstanding timers: ${atList}\nMembers: ${Object.keys(members).length}\nYou: ${me.name} (${me.role})`,
            );
          }
          case "selftest": {
            return notify(await runSelftest());
          }
          default: {
            const help = [
              "/team create <name> [--name You] [--role R]   create a team (and optionally join it)",
              "/team join <name> [--name You] [--role R]     join a team with your role",
              "/team leave                                   leave your team",
              "/team roster                                  show members + roles + status",
              "/team tasks                                   show the task board",
              "/team inbox                                   read pending messages",
              "/team set-role <role> / set-name <name>       update your role/name",
              "/team prune [--hours N]                       remove dead members (0 = dead only, default 24h)",
              "/team kick <name> [reason]                  coordinator: remove a member from the team",
              "/team memo <text>                            append to MEMORY.md in this directory (project memory)",
              "/team later <min> [--body Q] [--at HH:MM]   set a self-ping timer (harness wakes you; --cancel <id> to remove)",
              "/team timers                               list your timers",
              "/team export [name]                        write this team's definition to teams/<name>.json (commit to share)",
              "/team import <name> [--file <path>]        recreate a team from the repo's teams/ dir",
              "/team clear [--all]                       coordinator: wipe the board (tasks archived first) for a new project",
              "/team checkin [names...] [--body Q]       non-blocking status check (replies auto-wake you)",
              "/team await <names...> [--minutes N]       BLOCKING: wait for ALL named members to reply (one call, all at once)",
              "/team briefing [--body \"...\"]               read / set the team mission (coordinator can set)",
              "/team preset [save]                           show/refresh the saved team (name + role)",
              "/team preset create N=role [N=role ...]        seed the preset from scratch (multi roles ok)",
              "/team revive [--prompt ...]                   spawn the whole preset team back in terminals",
              "pi --team <name>                            one-shot launcher: this terminal becomes the coordinator",
              "/team config                                  show team settings",
              "/team selftest                                run bus self-tests",
              "",
              "Agents coordinate via the team tool: dm, task, report, broadcast, board_write/read,",
              "task_create/task_list/task_done (board tasks require evidence; kind=review adds a",
              "review gate that bounces failed work back; done is blocked on unfinished deps",
              "unless dep_override).",
              "Spawn a worker: PI_TEAM=<team> PI_TEAM_ROLE=<role> PI_TEAM_NAME=<name> pi",
            ].join("\n");
            return notify(help);
          }
        }
      } catch (e: any) {
        if (c.hasUI) c.ui.notify(`team error: ${e?.message ?? e}`, "error");
      }
    },
  });

  // -------------------------------------------------------------------------
  // optional TUI rendering for team messages
  // -------------------------------------------------------------------------

  (async () => {
    try {
      const tui: any = await import("@earendil-works/pi-tui");
      pi.registerMessageRenderer("team-briefing", (entry: any, { expanded }: any, theme: any) => {
        const content = entry.message?.content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.map((p: any) => p?.text || "").join("\n")
              : "";
        if (!text.trim()) {
          // Never render an empty "[team]" block — and do NOT return undefined
          // (pi then falls back to its own "[team-briefing]" box with empty
          // content). Return an invisible stub instead. Also log the empty
          // render so we can trace its source if it ever happens again.
          try {
            fs.appendFileSync(
              path.join(process.env.HOME || "/tmp", ".pi", "teams", ".pi-team-empty.log"),
              `${new Date().toISOString()} empty team-briefing render (customType=${entry.customType})\n`,
            );
          } catch { /* best effort */ }
          return new tui.Text("");
        }
        const box = new tui.Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
        box.addChild(new tui.Text(theme.bold("[team]")));
        const lines = text.split("\n");
        const shown = expanded ? lines : lines.slice(0, 10);
        for (const line of shown) box.addChild(new tui.Text(theme.fg("dim", line)));
        if (shown.length < lines.length) {
          box.addChild(new tui.Text(theme.fg("dim", `… ${lines.length - shown.length} more lines (expand)`)));
        }
        return box;
      });
    } catch {
      /* pi-tui unavailable: messages render as plain text */
    }
  })();

  // -------------------------------------------------------------------------
  // spawn: open a new terminal running pi pre-joined to the team
  // -------------------------------------------------------------------------

  async function spawnWorker(
    me: NonNullable<Awaited<ReturnType<typeof myTeam>>>,
    p: Record<string, any>,
    c: ExtensionContext,
  ): Promise<string> {
    const role = String(p.role || "").trim() || "worker";
    const name = String(p.name || "").trim();
    const prompt = String(p.prompt || "").trim();
    const cwd = c.cwd || process.cwd();
    const envPart = `PI_TEAM=${shq(me.team)} PI_TEAM_ROLE=${shq(role)} PI_TEAM_NAME=${shq(name)} PI_TEAM_DIR=${shq(me.root)}`;
    const who = name || role;
    // Title the terminal window before pi even boots (OSC 0 window-title
    // escape). pi re-applies the same title via ctx.ui.setTitle on session
    // start, so this only covers the pre-boot window.
    const title = `${me.team} / ${who} (${role})`;
    const titleCmd = `title=${shq(title)}; printf '\\033]0;%s\\007' "$title"; `;
    const inner = `${titleCmd}cd ${shq(cwd)} && ${envPart} exec pi${prompt ? ` -p ${shq(prompt)}` : ""}`;

    if (process.platform === "win32") {
      try {
        // Windows has no x-terminal-emulator. Use a separate PowerShell
        // process via `start`, preserving the worker's cwd and team env.
        const psq = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
        const extension = path.join(process.env.HOME || process.env.USERPROFILE || cwd, ".pi", "agent", "git", "github.com", "57Studios", "pi-team", "index.ts");
        const command = [
          `$Host.UI.RawUI.WindowTitle = ${psq(title)}`,
          `Set-Location -LiteralPath ${psq(cwd)}`,
          `$env:PI_TEAM = ${psq(me.team)}`,
          `$env:PI_TEAM_ROLE = ${psq(role)}`,
          `$env:PI_TEAM_NAME = ${psq(name)}`,
          `$env:PI_TEAM_DIR = ${psq(me.root)}`,
          `pi -e ${psq(extension)}${prompt ? ` -p ${psq(prompt)}` : ""}`,
        ].join("; ");
        const child = spawn("cmd.exe", ["/c", "start", "", "powershell.exe", "-NoExit", "-Command", command], { detached: true, stdio: "ignore" });
        child.unref();
        await bus.appendTeamLog(me.root, me.team, { ts: Date.now(), event: "spawn_attempt", name, role, launcher: "powershell" }).catch(() => {});
        return `Spawned "${who}" (${role}) in a new PowerShell window. It auto-joins team "${me.team}".`;
      } catch {
        /* fall through to generic launchers */
      }
    }

    if (process.platform === "darwin") {
      try {
        spawn(
          "osascript",
          ["-e", `tell application "Terminal" to do script "${titleCmd}cd ${shq(cwd)} && ${envPart} pi"`],
          { detached: true, stdio: "ignore" },
        ).unref();
        return `Spawned "${who}" (${role}) in a new Terminal window. It auto-joins team "${me.team}" on start.`;
      } catch {
        /* fall through to generic launchers */
      }
    }
    const launchers = [
      ...(process.env.TERMINAL ? [process.env.TERMINAL] : []),
      "x-terminal-emulator",
      "gnome-terminal",
      "konsole",
      "kitty",
      "alacritty",
      "wezterm",
      "xterm",
    ];
    const manualCmd = `cd ${shq(cwd)}\n  ${envPart} pi`;
    for (const t of launchers) {
      try {
        const child = spawn(t, ["-e", "bash", "-lc", inner], { detached: true, stdio: "ignore" });
        child.unref();
        child.on("error", () => { /* launcher missing/failed: try the next one */ });
        child.on("exit", (code) => {
          if (code !== 0) {
            // window failed to open or closed immediately; leave a trace
            bus.appendTeamLog(me.root, me.team, { ts: Date.now(), event: "spawn_exit", name, role, code }).catch(() => {});
          }
        });
        await bus.appendTeamLog(me.root, me.team, { ts: Date.now(), event: "spawn_attempt", name, role, launcher: t }).catch(() => {});
        return `Spawned "${who}" (${role}) in a new ${t} window. It auto-joins team "${me.team}" on start. If no window appears, run it manually:\n  ${manualCmd}`;
      } catch {
        /* try next launcher */
      }
    }
    return (
      `Could not find a terminal emulator to spawn a window. Start the worker manually in a new terminal:\n` +
      `  cd ${shq(cwd)}\n  ${envPart} pi\n` +
      `It auto-joins team "${me.team}" as ${name || role} on start.`
    );
  }

  function shq(s: string): string {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
  }

  // -------------------------------------------------------------------------
  // selftest (no LLM involved)
  // -------------------------------------------------------------------------

  async function runSelftest(): Promise<string> {
    const root = path.join(os.tmpdir(), `pi-team-selftest-${Date.now()}`);
    const log: string[] = [];
    const ok = (name: string, cond: boolean) => log.push(`${cond ? "PASS" : "FAIL"} ${name}`);
    try {
      await bus.createTeam(root, "acme", {});
      ok("create team", await bus.teamExists(root, "acme"));
      const j1 = await bus.joinMember(root, "acme", { id: "sessA", name: "Alice", role: "coordinator" });
      const j2 = await bus.joinMember(root, "acme", { id: "sessB", name: "Bob", role: "implementer" });
      ok("join two members", j1.ok && j2.ok);
      const dup = await bus.joinMember(root, "acme", { id: "sessC", name: "Alice", role: "x" });
      ok("duplicate name rejected", !dup.ok);
      const members = await bus.loadMembers(root, "acme");
      const tgt = bus.resolveTargets(members, "sessA", "role:implementer");
      ok("resolve role target", tgt.ids.length === 1 && tgt.ids[0] === "sessB");
      const sent = await bus.sendMessage(root, "acme", {
        type: "task",
        from: "sessA",
        fromName: "Alice",
        fromRole: "coordinator",
        to: "Bob",
        subject: "build parser",
        body: "Please build the parser",
        targets: tgt.ids,
      });
      ok("send task", sent.ok && sent.delivered === 1);
      const inboxB = await bus.drainInbox(root, "acme", "sessB");
      ok("Bob receives task", inboxB.length === 1 && inboxB[0].type === "task" && inboxB[0].body.includes("parser"));
      ok("inbox drained", (await bus.pendingCount(root, "acme", "sessB")) === 0);
      const bw = await bus.writeBoard(root, "acme", "design", "# Design\n\n- API: rest");
      const br = await bus.readBoard(root, "acme", "design");
      ok("board write/read", bw.ok && br.ok && br.content.includes("API: rest"));
      const lv = await bus.leaveMember(root, "acme", "sessB");
      ok("leave", lv.ok);
      const after = await bus.loadMembers(root, "acme");
      ok("member removed", !after.sessB);
      // task board
      await bus.joinMember(root, "acme", { id: "sessB", name: "Bob", role: "implementer" });
      const tk = await bus.createTask(root, "acme", {
        title: "build parser",
        body: "Implement the parser",
        assignee: "role:implementer",
        criteria: ["parses JSON", "tests pass"],
        createdBy: "sessA",
        createdByName: "Alice",
      });
      ok("create task", tk.ok && tk.task.status === "queued");
      ok("assignee notified on create", tk.notified === 1);
      const badDone = await bus.updateTask(root, "acme", tk.task.id, { status: "done" }, { id: "sessB", name: "Bob", role: "implementer" });
      ok("done without evidence rejected", !badDone.ok);
      const goodDone = await bus.updateTask(
        root, "acme", tk.task.id, { status: "done", evidence: "crates/parser.rs; 12 tests pass" },
        { id: "sessB", name: "Bob", role: "implementer" },
      );
      ok("done with evidence", goodDone.ok && goodDone.task.status === "done" && goodDone.notified === 1);
      const aliceIn = await bus.drainInbox(root, "acme", "sessA");
      ok("creator got task_done notice", aliceIn.some((m) => m.type === "task_done"));
      // hard dependency gate: done is rejected until deps finish (or dep_override)
      const dep1 = await bus.createTask(root, "acme", { title: "API spec", createdBy: "sessA", createdByName: "Alice" });
      const dep2 = await bus.createTask(root, "acme", { title: "implement API", dependsOn: [dep1.task.id], createdBy: "sessA", createdByName: "Alice" });
      const gated = await bus.updateTask(root, "acme", dep2.task.id, { status: "done", evidence: "done" }, { id: "sessB", name: "Bob", role: "implementer" });
      ok("done blocked by unfinished dep", !gated.ok && gated.error.includes("dep_override"));
      const overridden = await bus.updateTask(root, "acme", dep2.task.id, { status: "done", evidence: "done", depOverride: "spec deferred by coordinator" }, { id: "sessB", name: "Bob", role: "implementer" });
      ok("dep_override accepts", overridden.ok && overridden.warnings.some((w) => w.includes("dep_override")));
      // review gate: failing the review bounces the work back to running
      const work = await bus.createTask(root, "acme", { title: "feature X", assignee: "role:implementer", createdBy: "sessA", createdByName: "Alice" });
      const review = await bus.createTask(root, "acme", { title: "review feature X", kind: "review", reviewOf: work.task.id, assignee: "role:reviewer", createdBy: "sessA", createdByName: "Alice" });
      ok("review task created", review.ok && review.task.kind === "review" && review.task.reviewOf === work.task.id);
      const badReview = await bus.createTask(root, "acme", { title: "review missing", kind: "review", reviewOf: "t_nope", createdBy: "sessA", createdByName: "Alice" });
      ok("review of unknown task rejected", !badReview.ok);
      await bus.updateTask(root, "acme", work.task.id, { status: "done", evidence: "implemented" }, { id: "sessB", name: "Bob", role: "implementer" });
      const bounce = await bus.updateTask(root, "acme", review.task.id, { status: "failed", reason: "edge case uncovered" }, { id: "sessC", name: "Carol", role: "reviewer" });
      ok("review fail bounces work", bounce.ok && bounce.bouncedTaskId === work.task.id);
      const afterBounce = (await bus.loadTasks(root, "acme")).find((x) => x.id === work.task.id);
      ok("work back to running", afterBounce.status === "running");
      const bobIn = await bus.drainInbox(root, "acme", "sessB");
      ok("implementer notified of bounce", bobIn.some((m) => m.type === "task_bounced"));
      const pass = await bus.updateTask(root, "acme", review.task.id, { status: "done", evidence: "expiry handled" }, { id: "sessC", name: "Carol", role: "reviewer" });
      ok("review pass accepts work", pass.ok && pass.acceptedTaskId === work.task.id);
      // hygiene: prune + sweep + rotation
      const pruned = await bus.pruneMembers(root, "acme", { olderThanMs: 0 });
      ok("prune removes stale members", pruned.removed >= 2);
      const tmpFile = path.join(bus.teamDir(root, "acme"), "inbox", "sessA", "x.tmp-123");
      fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
      fs.writeFileSync(tmpFile, "stale");
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(tmpFile, old, old);
      await bus.sweepTeam(root, "acme");
      ok("sweep removes stale tmp files", !fs.existsSync(tmpFile));
      // dead-session reclaim + preset
      bus.setMemberStatusSync(root, "acme", "sessA", "offline");
      const re = await bus.joinMember(root, "acme", { id: "sessA2", name: "Alice", role: "coordinator" });
      ok("offline session name reclaimed", re.ok);
      const preset = await bus.loadPreset(root, "acme");
      ok("preset tracks roster", preset && preset.members.some((m) => m.name === "Alice"));
      return "SELFTEST: " + log.join(" | ");
    } catch (e: any) {
      return "SELFTEST FAIL: " + (e?.message ?? e) + " | " + log.join(" | ");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}
