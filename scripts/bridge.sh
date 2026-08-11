#!/usr/bin/env bash
# Convenience: delegate to bridge/scripts/bridge.sh (the real control script).
exec "$(dirname "$0")/../bridge/scripts/bridge.sh" "$@"
