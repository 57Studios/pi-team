# pi-team

Turn multiple pi instances into a coordinated **agent team** — agents DM each
other, assign tasks, post reports, and share a board, with the roles you
assign. Think jcode's swarm, but as a pi extension: no server, no ports, just a
shared directory and pi's extension hooks.

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Alice       │  │  Bob         │  │  Carol       │
│  (coordinator)│  │ (implementer)│  │  (reviewer)  │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │  team dm/task   │  team report    │
       └────────────────►└───────────────►└──────┘
                          shared directory
                        ~/.pi/teams/<team>/
                        (members, inboxes, board, log)
```

## Install

Put this directory at `~/.pi/agent/extensions/pi-team/` (already done if you're
reading this there). It's auto-discovered; run `/reload` in pi if it was added
while pi was running. Verify with `/team selftest`.

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

## What each side sees

- **New DM while idle** → TUI notification (`[team:invader] 1 new message(s)...`).
- **New DM at the start of a turn** → auto-injected into context as a
  `[team inbox — N new messages]` block plus a one-line roster
  (`[team:invader] Alice(coordinator), Bob(implementer), Carol(reviewer)`).
- **New DM while mid-turn** → injected before the agent's next LLM call
  (soft interrupt, like jcode).
- Agents can also check anytime with `team inbox` (via the `team` tool).

## The `team` tool (what agents call)

| Action | Purpose |
|--------|---------|
| `team dm <name\|role:R> --body "..."` | direct message a member or a role |
| `team task <name\|role:R> --subject S --body "..."` | assign work (high priority) |
| `team report --body "..."` | send completion report to `role:coordinator` |
| `team broadcast --body "..."` | message everyone |
| `team inbox` | read pending messages (drains) |
| `team roster` | list members, roles, statuses |
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
| `team create/join/leave/set_role/whoami` | team lifecycle |

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
  the implementer. Notifications are atomic with the transition — no missed
  handoffs.
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

A footer status shows `[team:name] N members · M msg · X/Y tasks done`,
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
