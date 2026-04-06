#!/bin/bash
# Removes git worktrees for agents.
# Run on HOST. WARNING: This removes uncommitted work in worktrees!
#
# Usage:
#   ./teardown-worktrees.sh            # Remove all worktrees
#   ./teardown-worktrees.sh 3 5        # Remove specific agent worktrees

set -euo pipefail

REPO="${CHT_CORE_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}"
WORKTREE_BASE="$REPO/.agents/worktrees"

teardown_worktree() {
  local id=$1
  local worktree_dir="$WORKTREE_BASE/agent-${id}"

  if [ ! -d "$worktree_dir" ]; then
    echo "[agent-$id] No worktree found at $worktree_dir"
    return 0
  fi

  # Check for uncommitted changes
  if cd "$worktree_dir" && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "[agent-$id] WARNING: Uncommitted changes detected!"
    git status --short
    read -p "[agent-$id] Remove anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      echo "[agent-$id] Skipped."
      return 0
    fi
  fi

  cd "$REPO"
  echo "[agent-$id] Removing worktree at $worktree_dir..."
  # git worktree remove can fail with relative gitdir paths.
  # Fall back to manual cleanup + prune if it does.
  if ! git worktree remove "$worktree_dir" --force 2>/dev/null; then
    echo "[agent-$id] git worktree remove failed, cleaning manually..."
    rm -rf "$worktree_dir"
    rm -rf "$REPO/.git/worktrees/agent-${id}"
    git worktree prune
  fi
  echo "[agent-$id] Removed."
}

if [ $# -gt 0 ]; then
  AGENTS=("$@")
else
  AGENTS=(1 2 3 4 5 6 7)
fi

for id in "${AGENTS[@]}"; do
  teardown_worktree "$id"
done

echo ""
echo "Remaining worktrees:"
cd "$REPO" && git worktree list
