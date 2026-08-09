#!/usr/bin/env bash
# pi-team installer — single command:
#   curl -fsSL https://raw.githubusercontent.com/57Studios/pi-team/main/install.sh | bash
#
# Clones (or updates) the extension into pi's auto-discovered extension
# directory, so it loads on the next /reload. No npm install needed: pi
# provides typebox and @earendil-works/pi-tui as built-in imports.
set -euo pipefail

REPO="${PI_TEAM_REPO:-https://github.com/57Studios/pi-team.git}"
BRANCH="${PI_TEAM_BRANCH:-main}"
DEST="${PI_TEAM_DIR:-$HOME/.pi/agent/extensions/pi-team}"

command -v git >/dev/null 2>&1 || { echo "error: git is required." >&2; exit 1; }
command -v pi >/dev/null 2>&1 || echo "note: 'pi' not on PATH — install pi first, then /reload."

mkdir -p "$(dirname "$DEST")"

if [ -d "$DEST/.git" ]; then
  echo "pi-team already installed at $DEST — updating to $BRANCH..."
  if [ -n "$(git -C "$DEST" status --porcelain)" ]; then
    echo "warning: local changes in $DEST will be overwritten (stash them first if you want to keep them)."
  fi
  git -C "$DEST" fetch --quiet origin "$BRANCH"
  git -C "$DEST" reset --hard --quiet "origin/$BRANCH"
else
  echo "Installing pi-team into $DEST ..."
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$DEST"
fi

test -f "$DEST/index.ts" || { echo "error: index.ts not found after install." >&2; exit 1; }
echo
echo "pi-team installed at: $DEST"
echo
echo "Next steps:"
echo "  1. In pi, run:  /reload"
echo "  2. Verify:      /team selftest"
echo "  3. One-shot launch:  pi --team <name>"
