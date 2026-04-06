#!/bin/bash
# Creates git worktrees for all agents from the playtime branch.
# Run on HOST before starting agent containers.
#
# Also hardens .git/config: overrides remotes to /dev/null so agents
# cannot push even if they bypass other protections. This is done here
# (on the host) because .git/config is mounted read-only into containers.
#
# Usage:
#   ./setup-worktrees.sh              # Create all 7 worktrees
#   ./setup-worktrees.sh 1 4 7        # Create specific agent worktrees

set -euo pipefail

REPO="${CHT_CORE_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}"
WORKTREE_BASE="$REPO/.agents/worktrees"
BASE_BRANCH="playtime"

# Agent name mapping
declare -A AGENT_NAMES=(
  [1]="cht-datasource"
  [2]="sentinel"
  [3]="sync-streams"
  [4]="purge-preproc"
  [5]="powersync-sdk"
  [6]="rules-engine"
  [7]="integration"
)

setup_worktree() {
  local id=$1
  local name="${AGENT_NAMES[$id]:-agent-$id}"
  local branch="playtime-agent-${id}-${name}"
  local worktree_dir="$WORKTREE_BASE/agent-${id}"

  if [ -d "$worktree_dir" ]; then
    echo "[agent-$id] Worktree already exists at $worktree_dir"
    # Still fix paths in case they're absolute from a previous run
    relativize_worktree_paths "$id" "$worktree_dir"
    return 0
  fi

  echo "[agent-$id] Creating branch $branch from $BASE_BRANCH..."
  cd "$REPO"
  git branch "$branch" "$BASE_BRANCH" 2>/dev/null || true

  echo "[agent-$id] Creating worktree at $worktree_dir..."
  git worktree add "$worktree_dir" "$branch"

  # git worktree add writes absolute paths. Convert to relative so
  # the worktree works inside Docker containers where the repo is
  # mounted at a different path (e.g. /workspace/cht-core).
  relativize_worktree_paths "$id" "$worktree_dir"

  echo "[agent-$id] Ready."
}

relativize_worktree_paths() {
  local id=$1
  local worktree_dir=$2
  local wt_git_file="$worktree_dir/.git"
  local main_gitdir="$REPO/.git/worktrees/agent-${id}"
  local main_gitdir_file="$main_gitdir/gitdir"

  # 1. Fix the worktree's .git file:
  #    FROM: gitdir: /home/user/repo/.git/worktrees/agent-1
  #    TO:   gitdir: ../../../.git/worktrees/agent-1
  if [ -f "$wt_git_file" ]; then
    local rel_to_gitdir
    rel_to_gitdir=$(realpath --relative-to="$worktree_dir" "$main_gitdir")
    echo "gitdir: ${rel_to_gitdir}" > "$wt_git_file"
    echo "[agent-$id] .git file → relative: $rel_to_gitdir"
  fi

  # 2. Fix the main repo's gitdir back-pointer:
  #    FROM: /home/user/repo/.agents/worktrees/agent-1/.git
  #    TO:   ../../../.agents/worktrees/agent-1/.git
  if [ -f "$main_gitdir_file" ]; then
    local rel_to_worktree
    rel_to_worktree=$(realpath --relative-to="$main_gitdir" "$worktree_dir/.git")
    echo "${rel_to_worktree}" > "$main_gitdir_file"
    echo "[agent-$id] gitdir back-pointer → relative: $rel_to_worktree"
  fi
}

harden_git_config() {
  echo ""
  echo "=== Hardening .git/config for agent containers ==="
  cd "$REPO"

  # Save the real remote URL so the human can restore it
  REAL_URL=$(git config --local remote.origin.url 2>/dev/null || echo "unknown")
  echo "  Saving real remote URL to .git/.real-remote-url: $REAL_URL"
  echo "$REAL_URL" > "$REPO/.git/.real-remote-url"

  # Override all remote URLs to /dev/null
  for remote in $(git remote 2>/dev/null); do
    git config --local "remote.${remote}.url" "/dev/null"
    git config --local "remote.${remote}.pushurl" "/dev/null"
    echo "  Overrode remote '$remote' → /dev/null"
  done

  # Block GitHub URL patterns via pushInsteadOf
  git config --local url."error://push-blocked".pushInsteadOf "git@github.com:"
  git config --local url."error://push-blocked".pushInsteadOf "https://github.com/"
  git config --local url."error://push-blocked".pushInsteadOf "ssh://git@github.com/"

  echo ""
  echo "  .git/config is now hardened. Agents cannot push."
  echo ""
  echo "  To restore for your own use (on host):"
  echo "    git remote set-url origin \$(cat .git/.real-remote-url)"
  echo "  Or run: .devcontainer/scripts/restore-git-config.sh"
}

# Determine which agents to set up
if [ $# -gt 0 ]; then
  AGENTS=("$@")
else
  AGENTS=(1 2 3 4 5 6 7)
fi

mkdir -p "$WORKTREE_BASE"

for id in "${AGENTS[@]}"; do
  setup_worktree "$id"
done

harden_git_config

echo ""
echo "Worktrees created. Current layout:"
cd "$REPO" && git worktree list
