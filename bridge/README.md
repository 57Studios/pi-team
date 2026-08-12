# WhatsApp bridge & remote dispatcher

Text your team from WhatsApp while you're away. A **bridge daemon** connects to
WhatsApp; a **dispatcher agent** (a pi instance) reads your messages, routes
work to team coordinators, and replies to you on WhatsApp.

```
You (WhatsApp)  ⇄  bridge daemon (baileys)  ⇄  Dispatcher agent (pi)
                  ~/.pi/wa-bridge/              team "Dispatch"
                  (session auth here)           member "Dispatcher"
```

## Security model (read this)

- **The bridge is the only thing that talks to WhatsApp.** Session credentials
  live in `~/.pi/wa-bridge/auth/` — **outside this repo, never committed**.
  `bridge/node_modules/` and `bridge/.env` are gitignored.
- **Allowlist:** only numbers in `WA_OWNERS` can message it (fail-closed — no
  owners = nobody). Others are ignored.
- **Revocable:** WhatsApp → Settings → Linked devices → log out kills the
  bridge instantly. The QR is a one-time link, printed only on this machine.
- **Message content** flows through the team bus in `~/.pi/teams/` (outside
  the repo), like all team DMs.

## Setup (one time)

```bash
cd bridge && npm install          # baileys + qrcode-terminal

WA_OWNERS=+15551234567 ./bridge.sh start   # prints "started"
./bridge.sh logs            # scan the QR it prints (first run only)
```

Scan with your phone: **WhatsApp → Settings → Linked devices → Link a device**.

## Run the dispatcher

```bash
pi --team Dispatcher                # like pi --team Alpha / --team Zilla — opens
                                    # a terminal that becomes the Dispatcher agent
# (equivalent, explicit: scripts/run-dispatcher.sh pi)
```

`pi --team Dispatcher` is an alias for the Dispatch team (its single preset
member is named Dispatcher). It joins with the stable member id
`dispatcher-main`, which is exactly the inbox the bridge delivers into.

The dispatcher auto-reads each WhatsApp message, routes work via the team tool
(`roster --team X`, `checkin`, `dm to:"Alpha/Optimus"`, `task_create
--team X --project <repo>`), and replies with `team wa_reply --body "..."`.
Coordinators can DM it back (`to:"Dispatch/Dispatcher"`) — it relays to you.

## Control (from ANY directory)

```bash
bridge/scripts/install-global.sh   # one time: installs global 'bridge' + 'dispatch'
bridge start|stop|status|logs      # any directory
dispatch                           # run the dispatcher agent
```
(Or the repo-root form: `./bridge.sh start|stop|status|logs`.)

Stopping keeps the WhatsApp session — **no rescan needed** next start.

## Notes

- Resource use: ~80–120 MB RAM, ~0% CPU idle (pure JS — no browser).
- The bridge and the dispatcher are independent: bridge down = messages queue
  in the inbox; dispatcher down = bridge still receives until pi is back.
- Tests: `node bridge/test/lib.test.mjs` (7) + `node --experimental-strip-types test/bus.test.mjs` (214).
