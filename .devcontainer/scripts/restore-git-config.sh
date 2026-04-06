#!/bin/bash
# Restores .git/config to its original state after agent hardening.
# Run on HOST when you need to push/fetch from GitHub.
#
# Usage:
#   ./restore-git-config.sh           # Restore remote URL
#   ./restore-git-config.sh --check   # Show current state without changing

set -euo pipefail

REPO="${CHT_CORE_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}"
SAVED_URL_FILE="$REPO/.git/.real-remote-url"

cd "$REPO"

if [ "${1:-}" = "--check" ]; then
  echo "Current remote.origin.url: $(git config --local remote.origin.url 2>/dev/null || echo 'not set')"
  echo "Current remote.origin.pushurl: $(git config --local remote.origin.pushurl 2>/dev/null || echo 'not set')"
  echo "Saved real URL: $(cat "$SAVED_URL_FILE" 2>/dev/null || echo 'not saved')"
  exit 0
fi

if [ ! -f "$SAVED_URL_FILE" ]; then
  echo "ERROR: No saved remote URL found at $SAVED_URL_FILE"
  echo "You may need to set it manually:"
  echo "  git remote set-url origin git@github.com:Hareet/cht-core.git"
  exit 1
fi

REAL_URL=$(cat "$SAVED_URL_FILE")

echo "Restoring git remote config..."
git config --local remote.origin.url "$REAL_URL"
git config --local --unset remote.origin.pushurl 2>/dev/null || true

# Remove the pushInsteadOf blocks
git config --local --unset-all url.error://push-blocked.pushInsteadOf 2>/dev/null || true

echo "Restored remote.origin.url to: $REAL_URL"
echo ""
echo "To re-harden after you're done pushing:"
echo "  .devcontainer/scripts/setup-worktrees.sh"
echo "  (it's idempotent — won't recreate existing worktrees)"
