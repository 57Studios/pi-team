# pi-team

Make multiple pi agents work as one team — they DM each other, assign tasks,
post reports, and share a board, with roles you assign. No server, no ports:
just a shared folder and pi's extension hooks.

## Install

Put this folder at `~/.pi/agent/extensions/pi-team/` and run `/reload` in pi.
Verify with `/team selftest`.

## One-shot launch: `pi --team <name>`

```
pi --team alpha
```

From any terminal: this terminal **becomes the coordinator** (Optimus for
Alpha — the first `coordinator`-role member of the preset) and **spawns every
other preset member** in new terminals, each pre-joined with its name/role
and titled `team / name (role)`. Members already live are skipped. Requires
the preset to exist (`/team preset create` or previous joins). Note: use
`--team` (double dash) — pi's parser rejects the single-dash `-team`.

## Quick start (3 terminals)

**Terminal 1 — the coordinator:**

```
/team create invader --name Alice --role coordinator
```

**Terminal 2 — an implementer:**

```
/team join invader --name Bob --role implementer
```

**Terminal 3 — a reviewer:**

```
/team join invader --name Carol --role reviewer
```

Now tell Alice's agent something like: *"DM Bob and assign him the parser. Have
Carol review it when Bob reports back."* Alice's agent calls `team task
role:implementer ...`, Bob's pi instance gets a notification, Bob sees the task
injected at the start of his next turn, does the work, and sends
`team report` back to `role:coordinator`. Carol gets looped in the same way.

## Project memory (MEMORY.md)

pi persists each agent's **private** session transcript, and loads `AGENTS.md`
as *input* — neither is shared project memory. pi-team adds one: a
`agent-team/MEMORY.md` in the working directory (the repo all agents share),
so a team spawned with "open terminal here" leaves a durable, human-readable
project memory — tucked in its own `agent-team/` folder so it never collides
with other harnesses' root-level `MEMORY.md` / `AGENTS.md` conventions:

- **Auto-seeded** on join/spawn: if `agent-team/MEMORY.md` doesn't exist, it's
  created with a header and a starter entry.
- **Appended via `team memo --body "..."` / `/team memo <text>`** — each entry
  is date- and author-tagged (`## 2026-08-09 12:49 · Bee (implementer)`),
  so the file doubles as an activity log. Concurrent appends are serialized
  (lock file, stale-lock recovery) — no lost entries.
- **Referenced in the briefing**: every agent's standing briefing says to read
  `agent-team/MEMORY.md` when starting work and record decisions/gotchas/next
  steps with `team memo`, so a newly spawned member has project history, not
  just a role.
- Keep it in git or add `agent-team/` to `.gitignore` — your call; it's plain
  markdown either way.

## What each side sees

- **Standing briefing (injected when needed)** — each agent run starts with
  a `[team-context]` block: who they are, the team mission, who they report to
  (derived from the `coordinator` role), where completed work goes next
  (derived from the `reviewer` role), and the team protocol. It is **injected
  only when necessary**: the first run of a session, after compaction
  (`session_compact` marks it dirty), or when role/mission/roster changes —
  steady state costs **zero tokens** per prompt, but it can never decay.
  Offline members are marked `(offline)` in the roster so agents don't DM
  ghosts. The mission is set by the coordinator:
  `team briefing --body "..."` / `/team briefing --body "..."`.
- **New DM while idle** → TUI notification (`[team:invader] 1 new message(s)...`).
  Idle agents do **not** start work on their own — unless the message is
  marked **`--wake`**, or team `autoRespond` is on.
- **`team dm --wake` / `team task --wake`** → the recipient's pi **starts a
  turn** even while idle, so urgent/status-check messages get actual replies
  (rate-limited to ~3 auto-turns/min). This is the "nudge" for when the
  coordinator needs an answer now. Send results **echo whether wake applied**
  ("wake: YES/NO") and warn when a recipient is offline — so the model can't
  claim it woke people it didn't. Task assignments and task-event
  notifications (done/blocked/failed/bounced/low-confidence) always wake; so
  does `team report`.
- **Replies always wake — airtight.** A DM back to someone who recently
  messaged you (or broadcast to you) is detected as a reply from the audit
  log — stateless, restart-safe — and **forces wake even if the model never
  passes `--wake`**. A stranded late reply (like the Alpha check-in's Bee) is
  now impossible: the recipient's pi starts a turn the moment the reply
  lands. Explicit `--reply-to` also forces wake.
- **`/team config --auto-respond on|off`** (coordinator) → idle members
  auto-start a turn whenever a DM arrives (rate-limited). Default off to avoid
  surprise turns and ping-pong loops.
- **New DM to an idle member** → auto-read: the member auto-starts a turn
  (rate-limited ~3/min) and the message is injected as a
  `[team inbox — N new messages]` block (`[wake]` marked when applicable).
  `autoRespond` defaults ON — no "prompt your agent to read them" step.
  Coordinators can disable it with `/team config --auto_respond false`.
- **New DM while mid-turn** → injected before the agent's next LLM call
  (soft interrupt, like jcode).
- Agents can also check anytime with `team inbox` (via the `team` tool).
- **`team later --minutes 30 --body "..."`** (or `/team later 30 "..."`,
  `--at HH:MM`, `/team timers`, `/team later --cancel <id>`) — the model asks
  the harness to ping it: a persisted timer fires a wake turn at the due time
  (survives restarts; a missed timer fires on the next session start).
- **Standing cadence timers** (`/team config --auto-timers "Zed:15:run the
  next cycle;Daisy:30:scout scan"`, coordinator-only) — auto-armed at each
  member's session start and re-armed after every fire, so a recurring cadence
  (Zilla's 15-min cycle, 30-min scout scan) runs with zero model cooperation.
- **`team checkin`** (or `/team checkin [names...] [--body Q]`) — the
  **non-blocking** status check: wake-DMs everyone, you END YOUR TURN, and
  each reply auto-wakes you with injected progress (`[team-checkin] 2/5
  replied, still waiting on: ...`; `ALL N replied — produce the final status
  summary` when done). Offline members get the DM queued but don't block
  completion. Never sleep or poll the inbox waiting for replies.
- **`team await_members --to "A, B, C" --timeout_minutes 5`** (or
  `/team await A B C --minutes 5 [--any]`) — the BLOCKING variant, only when
  you truly must stay in one turn: pass ALL names at once (comma-separated)
  and it waits for every one of them or the timeout. Never call it once per
  member — that is what produced the one-by-one wait.

The briefing is **role-aware**: workers see the research/confidence protocol,
and a member with the `researcher` role sees their *duty* instead.

Example worker briefing (team with a researcher):

```
[team-context] You are Bee (implementer) in team "invader".
Mission: Build the parser; verify library compatibility first.
Team: Bee(implementer), Ghost(researcher), Optimus(coordinator, reviewer)
Report to: role:coordinator (Optimus) — use team report for completion reports;
  task_blocked/task_fail auto-notify them.
Pass completed work to: role:reviewer (Optimus) — created review tasks land
  there and bounce failed work back to you.
Protocol:
- If your work crosses another member's files/scope, DM them directly to
  coordinate and resolve conflicts — don't route everything through the
  coordinator.
- Research: whenever you need something searched, investigated, or fact-checked,
  DM role:researcher (Ghost) with the question. They send the full report back
  to you and a tldr to the coordinator.
- Confidence: if you feel uncertain about a design, a dependency, or any fact,
  immediately ask the researcher to investigate before proceeding — do not guess.
```

The researcher's own briefing swaps the protocol for their duty:

```
Protocol:
- Your duty: when any member DMs you a research request, investigate thoroughly,
  send the FULL report back to the requester, and send a one-line tldr to
  role:coordinator (Optimus). Explicitly flag anything you could not verify.
- If your work crosses another member's path, DM them directly to coordinate.
- If you feel uncertain about anything, say so explicitly in your report and
  note what you could not verify.
```

If the team has **no researcher**, the protocol falls back to "say so explicitly
in your report and let the coordinator decide next steps" — no dangling
instructions. The coordinator can extend the mission text (`team briefing
--body`) with any additional standing orders.

## The `team` tool (what agents call)

| Action | Purpose |
|--------|---------|
| `team dm <name\|role:R> --body "..." [--wake]` | direct message a member or a role (`--wake` starts a turn on an idle recipient) |
| `team task <name\|role:R> --subject S --body "..."` | assign work (high priority) |
| `team report --body "..."` | send completion report to `role:coordinator` |
| `team broadcast --body "..."` | message everyone |
| `team inbox` | read pending messages (drains) |
| `team roster` | list members, roles, statuses (offline members marked) |
| `team board_write --topic design --body "..."` | share a design note |
| `team board_read [--topic T]` | read board topics / one topic |
| `team status --status "blocked on parser"` | update your status |
| `team task_create --subject T --to Bob\|role:R [--body "..."] [--criteria ...] [--depends_on ...] [--kind work\|review] [--review_of T]` | create a board task (notifies assignee) |
| `team task_list` / `team task_show --task_id T` | view the board / one task |
| `team task_start --task_id T` | claim/start a task |
| `team task_done --task_id T --evidence "..." [--dep_override "reason"]` | complete a task (**evidence required**; blocked on unfinished deps unless overridden) |
| `team task_blocked --task_id T --body "reason"` / `task_fail` | report blockers/failure (escalates to coordinator) |
| `team task_assign --task_id T --to name\|role:R` | reassign (creator/coordinator only) |
| `team spawn --role implementer --name Dave [--prompt "..."]` | open a new terminal running pi, pre-joined |
| `team create/join/leave/kick/set_role/whoami` | team lifecycle (`kick` = coordinator removes a member; the kicked member gets a notice and their name frees up) |
| **custom role names** | `hasRole` maps aliases to capabilities, so a team can name roles `Hub`, `Math`, `Executor`, `Scout` (coordinator, planner, implementer, researcher) and keep all machinery — briefing, report routing, kick gating, review gates, launch coordinator selection. Team names resolve case-insensitively (`pi --team zilla` → `Zilla`). |

Addresses: a member **name** (unique per team) or **`role:<role>`** (fans out
with that role, excluding the sender). `report` defaults to `role:coordinator`.

## Task board (the structured part)

Plain DMs are lossy — jcode's own docs say chat is the wrong primary
abstraction. The task board (`tasks.json`) is the lightweight version of
their "typed artifacts on a DAG" without an engine:

- Tasks live on the board with **status** (`queued → running → done`, plus
  `blocked`/`failed`), **assignee** (name or `role:`), **acceptance criteria**,
  and **dependencies**.
- **Evidence is enforced**: `task_done` without evidence is rejected. The
  agent must say what changed (file refs) and what validation it ran — a bare
  "done" is structurally impossible, like jcode's gate on artifacts.
- **Hard dependency gate**: `task_done` is *rejected* while any `depends_on`
  is unfinished, unless the agent passes `dep_override` with a reason —
  jcode's "parent cannot close with open gaps," with an escape hatch.
- **Review tasks** (`--kind review --review_of <task id>`): an independent
  reviewer (different role/name) passes with evidence, or **bounces the work**
  — failing the review flips the reviewed task back to `running` and notifies
  its implementer; passing it (while bounced) accepts the work as done.
  This is jcode's critique gate, made concrete.
- **Escalation is automatic**: blocked/failed tasks notify the coordinator
  (fallback: the creator); completed tasks notify the creator; bounces notify
  the implementer; **LOW-confidence completions** (`--confidence low` on
  `task_done`, leniently parsed — words or scores like `0.7` / `70%`) notify
  the coordinator *and* auto-create a research follow-up task assigned to
  `role:researcher` (fallback: coordinator), so uncertainty becomes structured
  work instead of a footnote. Notifications are atomic with the transition —
  no missed handoffs.
- **Permissions are light and social**: assignee/role/coordinator can change
  status; unassigned tasks are claimable by anyone; only creator/coordinator
  can reassign; a same-role reviewer gets a warning.
- Everyone sees the whole board (`team task_list`, `/team tasks`), so the
  coordinator can review evidence and push back — the social layer of
  jcode's critique gate.

## The `/team` commands (what you type)

```
/team create <name> [--name You] [--role R]    create a team (and optionally join)
/team join  <name> [--name You] [--role R]     join with your role
/team kick <name> [reason]                    coordinator: remove a member (roster + preset)
/team leave                                    leave your team
/team roster                                   members + roles + statuses
/team tasks                                    show the task board
/team inbox                                    read pending messages
/team set-role <role>   /team set-name <name>  change your role/name
/team prune [--hours N]                             remove dead members (0 = dead only, default 24h)
/team preset [save]                             show/refresh the saved team (name + role)
/team revive [--prompt ...]                     spawn the whole preset team back in terminals
/team config                                   team settings (autoRespond, interject)
/team selftest                                 run the built-in self tests
```

## Crash recovery & the team preset

**Power loss / crash-safe names.** Every member heartbeats (`lastSeen` touched
every 60s while running) and marks itself `offline` on graceful close. A name
is only "taken" by a **live** member; a dead session (crash, power loss, closed
terminal) releases its name automatically once its heartbeat goes stale
(~5 min), or immediately if it shut down gracefully. So after a power cut you
can rejoin with the same name — no manual cleanup. `prune --hours 0` reaps
dead sessions right away.

**Team preset ("call the team back").** The team directory keeps a
`preset.json` — the *intended* roster (name + role), auto-updated whenever
someone joins, leaves, or changes role. It's plain disk state, so it survives
crashes. When you want the whole team back:

```
/team revive            # coordinator: opens a terminal per preset member
/team preset            # see who's in the preset
/team preset save       # refresh it from the current live roster
/team preset create N=role [N=role ...]   # seed the preset from scratch
```

Seed a preset from scratch without anyone having joined yet — useful for
defining a team before it exists:

```
/team preset create Optimus=coordinator, reviewer Bee=implementer Ghost=researcher
```

Roles are free-form and may be **comma-separated for multi-role members**
(e.g. `coordinator, reviewer`): `role:<role>` addressing, coordinator
escalation, and review-task permissions all honor every role a member holds.

`revive` skips members who are already live, and spawns the rest in new
terminals with their preset name/role baked into the env — they auto-join
on startup. Agents can do the same via `team revive` / `team preset_show` /
`team preset_save`.

## Housekeeping (automatic + on demand)

Storage can't grow unboundedly:

- **Log rotation**: `log.jsonl` rotates at 5 MB (`TEAM_LOG_MAX_BYTES`),
  keeping the last 3 rotated files.
- **Temp-file sweep**: stale `*.tmp-*` files (from a killed writer) older
  than 1h are removed automatically.
- **Dead-member pruning**: members last seen > 7 days ago are pruned
automatically; `/team prune [--hours N]` sweeps sooner (default 24h,
`--hours 0` reaps dead sessions immediately).
- The sweep runs ~1/hour per instance while in a team (throttled, cheap).

## UI

- **Terminal title** — each agent's window/tab is titled
  `team / name (role)`, e.g. `Alpha / Bee (implementer)`, so you can tell
  who's who at a glance. Set by pi itself on session start (covers resume),
  and pre-set by the spawn/revive command before pi boots (OSC window-title
  escape).
- **Footer status** — `[team:name] N members · M msg · X/Y tasks done`,
  updated on join/leave, new mail, and task transitions (refreshed at most
  once per 15s). Teammates see you as `offline` after you close pi.

## Roles & hierarchy

Roles are free-form strings you assign at join time (`coordinator`, `architect`,
`implementer`, `reviewer`, ...). There is no hardcoded permission tree — the
hierarchy is social: `report` routes to `role:coordinator`, `task` marks work
high-priority, and everyone can see the roster and DM anyone. Names are unique
per team, so DMs are unambiguous.

## Spawning workers (like a company hiring)

From inside a team, a coordinator agent can call `team spawn` to open a new
terminal running pi pre-joined to the team. It works by launching your terminal
emulator with:

```
PI_TEAM=<team> PI_TEAM_ROLE=<role> PI_TEAM_NAME=<name> PI_TEAM_DIR=<dir> pi
```

Any pi started with those env vars auto-joins on startup (also useful for
scripted/CI workers). If no terminal emulator is found, the tool prints the
exact command to paste.

## Remote members

The team directory defaults to `~/.pi/teams/<team>` (override with `--dir` or
`PI_TEAM_DIR`). Point it at a folder everyone can see — a synced drive,
sshfs mount, or a gitignored folder in a shared repo — and instances on
different machines join the same team.

## How it works

- **Transport**: atomic file writes under `~/.pi/teams/<team>/` —
  `team.json` (settings), `members.json` (roster), `inbox/<memberId>/`
  (per-member queues), `board/*.md` (shared notes), `log.jsonl` (audit).
- **Concurrency**: `members.json` updates go through a lock directory with
  stale-lock recovery; message writes are atomic renames, so concurrent sends
  never interleave. (29 unit assertions in `test/bus.test.mjs` cover this.)
- **Identity**: joining records your name/role in the session
  (`pi.appendEntry`) so resuming the session auto-rejoins you. Env vars
  override for spawned workers.
- **Delivery**: `before_agent_start` drains your inbox into context;
  a file watcher notifies on new mail and can steer-inject mid-turn;
  `autoRespond` (edit `team.json`, default off, rate-limited) makes an idle
  agent wake up and act on a DM automatically.
- **Read == consumed**: a message is delivered exactly once (drained by
  whichever path reads it first).

## Tuning

Edit `~/.pi/teams/<team>/team.json`:

```json
{ "name": "invader", "autoRespond": false, "interject": true }
```

- `autoRespond: true` — idle members start a turn when a DM arrives
  (max 3 auto-turns/minute).
- `interject: false` — busy members stop seeing DMs mid-turn; they only see
  them at the next turn start.

## Files

```
~/.pi/agent/extensions/pi-team/
├── index.ts          # the extension (tool, commands, events, injection)
├── bus.mjs           # pure-JS message bus (no pi imports, unit-testable)
├── test/bus.test.mjs # node test/bus.test.mjs
└── README.md
```

## Design notes vs jcode's swarm

| jcode | pi-team |
|-------|---------|
| server-owned member registry | shared filesystem registry (no server) |
| soft-interrupt DM injection | `before_agent_start` + watcher steer-injection |
| coordinator owns a `VersionedPlan` | coordinator role is social; tasks are structured board items |
| DAG engine: gates, typed artifacts, acyclicity | task board: review tasks, required evidence, hard dep gate, dependency warnings |
| critique gate converts gaps into nodes | review tasks bounce failed work back; blocked/failed escalates to coordinator |
| worktree managers, git worktrees | shared repo, optimistic file edits |
| 1000-member cap, RAM budget | no hard cap (practical limit = filesystem); log rotation + pruning keep storage bounded |

Like jcode, coordination is **explicit and optimistic**: no locks on files,
agents resolve conflicts by DMing each other. The task board borrows jcode's
core lesson — evidence is enforced, gaps surface as bounces/warnings —
without the engine.
