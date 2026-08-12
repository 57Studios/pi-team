#!/usr/bin/env bash
# WhatsApp bridge control (works from anywhere, but meant for the repo root):
#   ./bridge.sh start|stop|status|logs
# Session auth lives in ~/.pi/wa-bridge/ (OUTSIDE the repo) — never committed.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/bridge" && pwd)/scripts/bridge.sh" "$@"
