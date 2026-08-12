#!/usr/bin/env bash
# pi-team WhatsApp bridge control: start | stop | status | logs
# Session auth lives in ~/.pi/wa-bridge/ (OUTSIDE the repo) — never committed.
# Works from any directory.
set -euo pipefail
BRIDGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_DIR="${PI_WA_DIR:-$HOME/.pi/wa-bridge}"
PIDFILE="$BRIDGE_DIR/bridge.pid"
LOGFILE="$BRIDGE_DIR/bridge.log"

OWNERS="${WA_OWNERS:-}"
alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
# kill EVERY daemon by name (pidfile pids drift with subshell backgrounding)
kill_all() {
  pkill -f "node index.mjs" 2>/dev/null || true
  rm -f "$PIDFILE"
}

cmd="${1:-status}"
case "$cmd" in
  start)
    [ -n "$OWNERS" ] || { echo "error: set WA_OWNERS (your number). e.g. WA_OWNERS=+15551234567 scripts/bridge.sh start" >&2; exit 1; }
    if alive; then echo "already running (pid $(cat "$PIDFILE"))"; exit 0; fi
    kill_all
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
  status)
    if alive; then echo "running (pid $(cat "$PIDFILE"))"; tail -3 "$LOGFILE" 2>/dev/null || true
    else echo "not running"; fi
    ;;
  logs) tail -f "$LOGFILE" 2>/dev/null || echo "no log yet — run start first" ;;
  *) echo "usage: $0 {start|stop|status|logs}" >&2; exit 2 ;;
esac
