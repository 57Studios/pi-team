#!/usr/bin/env bash
# Install global 'bridge' and 'dispatch' commands (work from any directory).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/bridge" <<SHIM
#!/usr/bin/env bash
exec "$REPO/bridge/scripts/bridge.sh" "\$@"
SHIM
cat > "$HOME/.local/bin/dispatch" <<SHIM2
#!/usr/bin/env bash
exec "$REPO/scripts/run-dispatcher.sh" "\$@"
SHIM2
chmod +x "$HOME/.local/bin/bridge" "$HOME/.local/bin/dispatch"
echo "installed: bridge (WhatsApp bridge control) and dispatch (dispatcher agent) — usable from any directory."
