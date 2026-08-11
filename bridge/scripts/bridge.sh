#!/usr/bin/env bash
# pi-team WhatsApp bridge control: start | stop | status | logs
# Session auth lives in ~/.pi/wa-bridge/ (OUTSIDE the repo) — never committed.
set -euo pipefail
cd "$(dirname "$0")/.."
BRIDGE_DIR="${PI_WA_DIR:-$HOME/.pi/wa-bridge}"
PIDFILE="$BRIDGE_DIR/bridge.pid"
LOGFILE="$BRIDGE_DIR/bridge.log"

# Owner numbers (required): add your WhatsApp number(s), comma/space separated.
#   WA_OWNERS="+15551234567 +14155559876" scripts/bridge.sh start
OWNERS="${WA_OWNERS:-}"

cmd="${1:-status}"
case "$cmd" in
  start)
    [ -n "$OWNERS" ] || { echo "error: set WA_OWNERS (your number). e.g. WA_OWNERS=+15551234567 scripts/bridge.sh start" >&2; exit 1; }
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "already running (pid $(cat "$PIDFILE"))"
      exit 0
    fi
    mkdir -p "$BRIDGE_DIR"
    (cd bridge && WA_OWNERS="$OWNERS" PI_WA_DIR="$BRIDGE_DIR" nohup node index.mjs >> "$LOGFILE" 2>&1 & echo $! > "$PIDFILE")
    sleep 2
    echo "started (pid $(cat "$PIDFILE")). Logs: $LOGFILE"
    echo "first run: scan the QR it prints in the log — tail -f $LOGFILE"
    ;;
  stop)
    [ -f "$PIDFILE" ] || { echo "not running"; exit 0; }
    kill "$(cat "$PIDFILE")" 2>/dev/null && echo "stopped (WhatsApp session persists — no rescan needed)" || echo "no process"
    rm -f "$PIDFILE"
    ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "running (pid $(cat "$PIDFILE"))"
      tail -3 "$LOGFILE" 2>/dev/null || true
    else
      echo "not running"
    fi
    ;;
  logs) tail -f "$LOGFILE" 2>/dev/null || echo "no log yet" ;;
  *) echo "usage: $0 {start|stop|status|logs}" >&2; exit 2 ;;
esac
