#!/usr/bin/env bash
# pi-team WhatsApp bridge control: start | stop | status | logs | allow | prune
# Session auth lives in ~/.pi/wa-bridge/ (OUTSIDE the repo) — never committed.
# Works from any directory.
set -euo pipefail
BRIDGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_DIR="${PI_WA_DIR:-$HOME/.pi/wa-bridge}"
PIDFILE="$BRIDGE_DIR/bridge.pid"
LOGFILE="$BRIDGE_DIR/bridge.log"
OWNERS_FILE="$BRIDGE_DIR/owners.txt"

alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
# kill EVERY daemon by name (pidfile pids drift with subshell backgrounding)
kill_all() {
  pkill -f "node index.mjs" 2>/dev/null || true
  rm -f "$PIDFILE"
}
# Rotate bridge.log at 1MB, keep 3 generations (QR spam during linking is big).
rotate_log() {
  [ -f "$LOGFILE" ] || return 0
  local size
  size="$(stat -c%s "$LOGFILE" 2>/dev/null || echo 0)"
  [ "$size" -gt 1048576 ] || return 0
  rm -f "$LOGFILE.3"
  [ -f "$LOGFILE.2" ] && mv "$LOGFILE.2" "$LOGFILE.3"
  [ -f "$LOGFILE.1" ] && mv "$LOGFILE.1" "$LOGFILE.2"
  mv "$LOGFILE" "$LOGFILE.1"
  echo "bridge.log rotated ($size bytes -> $LOGFILE.1)"
}

cmd="${1:-status}"
case "$cmd" in
  start)
    if [ -n "${WA_OWNERS:-}" ]; then
      # persist what was passed so future starts without env keep the list
      mkdir -p "$BRIDGE_DIR"
      echo "$WA_OWNERS" | tr ' ,' '\n' | sed 's/[^0-9]//g' | grep -v '^$' > "$OWNERS_FILE"
    fi
    OWNERS="$(tr '\n' ',' < "$OWNERS_FILE" 2>/dev/null)"
    [ -n "$OWNERS" ] || { echo "error: no owners yet. Set WA_OWNERS=+15551234567 scripts/bridge.sh start (saved to $OWNERS_FILE), or: $0 allow +1555..." >&2; exit 1; }
    if alive; then echo "already running (pid $(cat "$PIDFILE")) — owners: $OWNERS"; exit 0; fi
    kill_all
    rotate_log
    mkdir -p "$BRIDGE_DIR"
    ( cd "$BRIDGE_ROOT" && WA_OWNERS="$OWNERS" PI_WA_DIR="$BRIDGE_DIR" nohup node index.mjs >> "$LOGFILE" 2>&1 & echo $! > "$PIDFILE" )
    sleep 3
    if alive; then
      echo "started (pid $(cat "$PIDFILE")). Logs: $LOGFILE"
      echo "first run: cat $BRIDGE_DIR/qr.txt (or: bridge logs) and scan it — the QR rotates ~20s, qr.txt always holds the latest"
    else
      echo "FAILED to start — check the log:"; tail -5 "$LOGFILE" 2>/dev/null || true
      exit 1
    fi
    ;;
  stop)
    kill_all
    echo "stopped (WhatsApp session persists — no rescan needed)"
    ;;
  allow)
    num="${2:-}"
    [ -n "$num" ] || { echo "usage: $0 allow +15551234567" >&2; exit 2; }
    mkdir -p "$BRIDGE_DIR"
    touch "$OWNERS_FILE"
    norm="$(echo "$num" | sed 's/[^0-9]//g')"
    [ -n "$norm" ] || { echo "error: no digits in \"$num\"" >&2; exit 2; }
    if grep -qx "$norm" "$OWNERS_FILE" 2>/dev/null; then
      echo "already allowed: $num"; "$0" status; exit 0
    fi
    echo "$norm" >> "$OWNERS_FILE"
    echo "added $num to the allowlist ($OWNERS_FILE): $(tr '\n' ',' < "$OWNERS_FILE")"
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      "$0" stop >/dev/null 2>&1
      "$0" start
    else
      "$0" start
    fi
    ;;
  prune)
    rotate_log
    # Auth cache prune: lid-mapping/tctoken files are baileys caches that
    # regenerate on demand (1214 files after a day of linking). Keep ONLY the
    # allowlisted numbers' mappings (+ reverse) and session-critical files;
    # delete the rest. creds.json / app-state / pre-key / session / identity /
    # sender-key files are NEVER touched.
    OWNERS="$(tr '\n' ',' < "$OWNERS_FILE" 2>/dev/null)"
    python3 - "$OWNERS" <<'PYEOF'
import json, os, re, sys
owners = set(x for x in sys.argv[1].replace("+", "").split(",") if x)
auth = os.path.expanduser("~/.pi/wa-bridge/auth")
if not os.path.isdir(auth):
    print("no auth dir")
    sys.exit(0)
kept = removed = 0
for f in sorted(os.listdir(auth)):
    if not (f.startswith("lid-mapping-") or f.startswith("tctoken-")):
        continue  # session-critical: never touch
    m = re.match(r"^lid-mapping-(\d+)(_reverse)?\.json$", f)
    phone = None
    if m:
        key, reverse = m.group(1), bool(m.group(2))
        val = ""
        try:
            val = json.load(open(os.path.join(auth, f)))
        except Exception:
            pass
        phone = key if not reverse else str(val)
    elif f.startswith("tctoken-"):
        lid = re.match(r"^tctoken-(\d+)@lid\.json$", f)
        if lid:
            rev = os.path.join(auth, "lid-mapping-%s_reverse.json" % lid.group(1))
            try:
                phone = json.load(open(rev))
            except Exception:
                phone = None
    if phone and phone in owners:
        kept += 1
    else:
        os.unlink(os.path.join(auth, f))
        removed += 1
print(f"auth prune: kept {kept} (allowlisted), removed {removed} cache files (regenerate on demand)")
PYEOF
    ;;
  status)
    if alive; then echo "running (pid $(cat "$PIDFILE"))"; tail -3 "$LOGFILE" 2>/dev/null || true
    else echo "not running"; fi
    ;;
  logs) tail -f "$LOGFILE" 2>/dev/null || echo "no log yet — run start first" ;;
  *) echo "usage: $0 {start|stop|status|logs|allow <+number>|prune}" >&2; exit 2 ;;
esac
