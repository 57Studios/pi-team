<div align="center">

# 🐝 pi-team

### Turn multiple pi agents into one coordinated team

Agents DM each other, assign tasks, post reports, and share a board — with the
roles you assign. **No server, no ports:** just a shared folder and pi's
extension hooks.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Language: TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6.svg)
![Platform: pi](https://img.shields.io/badge/platform-pi-6f4fa0.svg)

```
pi --team alpha   →  you become the coordinator, everyone else spawns in new terminals
```

</div>

---

## ✨ Features

| | | |
|---|---|---|
| 💬 **Agent DMs** — auto-read & wake | 📋 **Task board** — evidence-gated, review gates | 🔁 **Standing timers** — self-ping cadence |
| 🏃 **Non-blocking checkin** — replies wake you | 🔍 **Built-in web search** — local SearXNG | 🤝 **Cross-team comm** — lead-to-lead |
| 🧠 **Auto-injected context** — briefing + project memory | 📦 **Portable teams** — presets in the repo | 💾 **Crash-durable** — serverless, survives power loss |

---

## 🚀 Install

```bash
curl -fsSL https://raw.githubusercontent.com/57Studios/pi-team/main/install.sh | bash
```

Then run `/reload` in pi and verify with `/team selftest`. No npm install
needed — pi provides `typebox` and `pi-tui`. Alternative: `pi install git:github.com/57Studios/pi-team`.

<details>
<summary><b>🪟 Windows</b></summary>

Install [pi](https://pi.dev) first, then from PowerShell:

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install git:github.com/57Studios/pi-team
```

Restart pi (or run `/reload`) after installation.

</details>

## ⚡ Quick start

```bash
pi --team alpha        # one terminal: you become the coordinator, the team spawns around you
/team create acme --name Alice --role coordinator    # …or start manually
/team join acme --name Bob --role implementer        # in other terminals
/team roster                                         # who's here
```

Custom role names work out of the box — `Hub` acts as coordinator, `Math` as
planner, `Executor` as implementer, `Scout` as researcher (see [Roles](#-roles)).

---

## 🛠️ What agents can do

| Action | Purpose |
|---|---|
| `team dm to:"Bob"` | DM a teammate — idle members are woken and read it (rate-limited) |
| `team task role:implementer --subject ...` | assign work (board is **evidence-gated**) |
| `team report` | completion report → coordinator (always wakes them) |
| `team checkin` | **non-blocking** status check: replies auto-wake you with progress |
| `team later --minutes 30 --body "..."` | self-ping timer — the harness wakes you at the due time |
| `team search "query"` | web search via local SearXNG (no API key) |
| `team dm to:"Zilla/Zed"` | **cross-team** DM — lead-to-lead only |
| `team board_write/read` | shared board — **per-project** in repos with `agent-team/` |
| `team memo` | append to `agent-team/MEMORY.md` (project memory) |
| `team await_members` | blocking wait — pass ALL names at once, one call |

**Task board rules:** `task_done` requires evidence · dependencies block
(unless `dep_override`) · `kind=review` tasks bounce failed work back ·
low-confidence completion auto-notifies the coordinator and spawns a research
follow-up.

## ⌨️ The `/team` commands

| Command | What it does |
|---|---|
| `create / join / leave / kick <name>` | team lifecycle (`kick` = coordinator removes a member) |
| `clear [--all]` | coordinator: wipe the board to pivot to a new project (tasks archived first) |
| `roster / inbox / board / tasks` | view state |
| `checkin [names...] [--body Q]` | non-blocking status check |
| `later <min> [--body Q] [--at HH:MM]` | self-ping timer (`--cancel <id>`, `timers` to list) |
| `search <q> [--count N] [--categories news]` | web search |
| `config --auto_respond true\|false` | idle auto-read on/off (default **ON**) |
| `config --auto-timers "Zed:15:run the next cycle"` | standing cadence timers (auto-armed) |
| `export / import <name>` | portable team definitions (`teams/` in the repo) |
| `revive / prune [--hours N] / preset` | recover dead sessions / clean up |
| `memo <text> / briefing` | project memory / team mission |
| `selftest` | verify the extension |

## 🎭 Roles

Members have free-form, comma-separated roles. Capability aliases keep the
machinery working with your vocabulary:

| Capability | Aliases |
|---|---|
| **coordinator** | hub, boss, lead, manager, captain, conductor, chief |
| **planner** | math, strategist, quant, architect, modeler |
| **implementer** | executor, operator, builder, engineer, coder, worker |
| **researcher** | scout, analyst, investigator, factfinder, intel |
| **reviewer** | auditor, veto, critic, inspector, qa |

Coordinators kick members, set the briefing, and change team settings.
**Cross-team DMs are lead-to-lead:** only coordinators, and only to the other
team's coordinator.

---

## 💾 Crash recovery & how it works

- Members **heartbeat every 60s**; a name is reclaimable once its owner goes
  offline or is stale >5 min. `/team revive` brings the preset back,
  `/team prune --hours N` cleans dead members.
- Standing timers re-arm automatically; everything persists on disk
  (inboxes, board, tasks, logs) — **atomic writes + lock dirs** make it
  crash-durable and serverless.
- Every member's extension watches its inbox and **auto-reads** incoming
  messages — replies, reports, and tasks always wake the right agent,
  **no model cooperation needed**.

### 🧠 Context, injected

Every agent's turn starts with the **standing briefing** (role, mission,
roster, protocol) and — when working inside a repo — the **project memory**
(`agent-team/MEMORY.md`) and **per-project task board**. Re-injected only when
they change; zero tokens in steady state.

## 📦 Portable teams

Team definitions live in the repo's `teams/` dir — a fresh clone has them all:

```bash
/team export Zilla   # write preset + briefing + settings + timers to teams/Zilla.json
/team import Zilla   # recreate a team from teams/Zilla.json
pi --team zilla      # auto-imports from teams/ if it isn't local yet
```

## 📁 Files

```
index.ts     extension (commands, tool, watcher, timers)
bus.ts       pure-TS message bus (no pi imports, unit-testable)
teams/       portable team definitions (Alpha.json, Zilla.json, …)
test/        unit tests
install.sh   one-command installer
```

## ✅ Tests

```bash
node --experimental-strip-types test/bus.test.mjs   # 212 assertions
/team selftest                                      # in pi
```

---

<div align="center">

Built with 🧡 for pi — [pi.dev](https://pi.dev) · issues & PRs welcome

</div>
