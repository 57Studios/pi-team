# pi-team

Make multiple pi agents work as one team — they DM each other, assign tasks,
post reports, and share a board, with roles you assign. No server, no ports:
just a shared folder and pi's extension hooks.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/57Studios/pi-team/main/install.sh | bash
```

Then run `/reload` in pi and verify with `/team selftest`. No npm install
needed (pi provides `typebox` and `pi-tui`). Alternative: `pi install
git:github.com/57Studios/pi-team`.

## Quick start

```bash
pi --team alpha          # one terminal: you become the coordinator, everyone else spawns in new terminals
/team create acme --name Alice --role coordinator    # or start manually
/team join acme --name Bob --role implementer        # in other terminals
/team roster                                         # who's here
```

Custom role names work: `Hub` behaves as coordinator, `Math` as planner,
`Executor` as implementer, `Scout` as researcher (aliases; see Roles).

## What agents can do

| Action | Purpose |
|---|---|
| `team dm to:"Bob"` | DM a teammate (auto-read: idle members get woken and read it — rate-limited) |
| `team task role:implementer --subject ...` | assign work (task board, evidence-gated) |
| `team report` | completion report → coordinator (always wakes them) |
| `team checkin` | **non-blocking** status check: wake-DM everyone, end your turn; replies auto-wake you with progress |
| `team later --minutes 30 --body "..."` | set a self-ping timer (persisted; fires a turn at the due time) |
| `team search "query"` | web search via local SearXNG (no API key; `--categories news`) |
| `team dm to:"Zilla/Zed"` | **cross-team** DM — lead-to-lead only (both coordinators) |
| `team board_write/read` | shared board |
| `team memo` | append to `agent-team/MEMORY.md` (project memory) |
| `team await_members` | blocking wait — pass ALL names at once, one call |

Task board: `task_done` requires evidence, dependencies block (unless
`dep_override`), `kind=review` tasks bounce failed work back, low-confidence
completion auto-notifies the coordinator and spawns a research follow-up.

## The `/team` commands (what you type)

```
/team create|join|leave|kick <name> [reason]   team lifecycle (kick = coordinator removes a member)
/team roster | inbox | board | tasks            view state
/team checkin [names...] [--body Q]             non-blocking status check
/team later <min> [--body Q] [--at HH:MM]       self-ping timer (--cancel <id>, /team timers)
/team search <q> [--count N] [--categories news]
/team config --auto_respond true|false          idle auto-read on/off (default ON)
/team config --auto-timers "Zed:15:run the next cycle;Daisy:30:scout scan"   standing cadence timers
/team revive | prune [--hours N] | preset       recover dead sessions / clean up
/team memo <text> | briefing                    project memory / team mission
/team selftest                                  verify the extension
```

## Crash recovery

Members heartbeat every 60s; a name is reclaimable once its owner goes
offline or is stale >5 min. `/team revive` brings the preset back;
`/team prune --hours N` cleans dead members. Standing timers re-arm
automatically, and everything persists on disk (inboxes, board, tasks, logs).

## Roles

Members have roles (free-form, comma-separated). Capability aliases keep the
machinery working with custom vocabulary:

| Capability | Aliases |
|---|---|
| coordinator | hub, boss, lead, manager, captain, conductor, chief |
| planner | math, strategist, quant, architect, modeler |
| implementer | executor, operator, builder, engineer, coder, worker |
| researcher | scout, analyst, investigator, factfinder, intel |
| reviewer | auditor, veto, critic, inspector, qa |

Coordinators can kick members, set the briefing, and change team settings.
Cross-team DMs are lead-to-lead: only coordinators, and only to the other
team's coordinator.

## How it works

A shared directory per team (`~/.pi/teams/<team>/`): members.json, inboxes,
board, tasks, audit log. Atomic writes + lock dirs make it crash-durable and
serverless. Every member's extension watches its inbox and auto-reads
incoming messages, so replies/reports/tasks always wake the right agent —
no model cooperation needed.

## Files

```
index.ts   extension (commands, tool, watcher, timers)
bus.ts     pure-TS message bus (no pi imports, unit-testable)
test/      unit tests (node --experimental-strip-types test/bus.test.mjs)
install.sh one-command installer
```

## Tests

```bash
node --experimental-strip-types test/bus.test.mjs   # 188 assertions
/team selftest                                      # in pi
```
