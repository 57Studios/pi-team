#!/usr/bin/env bash
# Run the WhatsApp dispatcher: a pi agent that answers WhatsApp messages and
# routes work to team coordinators. Requires the bridge to be running.
set -euo pipefail
cd "$(dirname "$0")/.."
exec env PI_TEAM=Dispatch PI_TEAM_NAME=Dispatcher PI_TEAM_ROLE="coordinator, dispatcher" PI_TEAM_ID=dispatcher-main "$@"
