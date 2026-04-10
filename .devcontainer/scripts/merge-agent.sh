#!/bin/bash
# Merge an agent's worktree branch back to the playtime base branch.
# Run on HOST by the human operator.
#
# Usage:
#   ./merge-agent.sh <agent-id>           # Direct merge (safe with active worktrees)
#   ./merge-agent.sh <agent-id> --squash  # Squash merge
#
# Merge order (based on dependencies):
#   1. Agent 1 (cht-datasource) - foundation
#   2. Agent 4 (purge-preproc) - parallel with Agent 1
#   3. Agent 2 (sentinel) - after Agent 1
#   4. Agent 7 (integration) - validates Agents 1+2
#   5. Agent 3 (sync-streams) - independent config
#   6. Agent 5 (powersync-sdk) - client-side
#   7. Agent 6 (rules-engine) - after Agent 5

set -euo pipefail

AGENT_ID=${1:?Usage: merge-agent.sh <agent-id> [--squash]}
SQUASH=${2:-}
REPO="${CHT_CORE_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}"
BASE_BRANCH="playtime"

cd "$REPO"

# Find the agent's branch — handle both normal and relative-path worktree listings
BRANCH=$(git branch --list "playtime-agent-${AGENT_ID}-*" | head -1 | sed 's/^[* +]*//')

if [ -z "$BRANCH" ]; then
  echo "ERROR: No branch found matching playtime-agent-${AGENT_ID}-*"
  echo "Available branches:"
  git branch --list "playtime-agent-*"
  exit 1
fi

echo "Merging $BRANCH -> $BASE_BRANCH"
echo ""

# Show what will be merged
echo "Commits to merge:"
git log --oneline "$BASE_BRANCH".."$BRANCH"
echo ""
echo "Files changed:"
git diff --stat "$BASE_BRANCH"..."$BRANCH"
echo ""

read -p "Proceed with merge? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

# Ensure we're on the base branch
git checkout "$BASE_BRANCH"

if [ "$SQUASH" = "--squash" ]; then
  echo "Squash merging $BRANCH..."
  git merge --squash "$BRANCH"
  git commit -m "feat: merge agent-${AGENT_ID} ($BRANCH) work into playtime

Squash merge of all commits from agent-${AGENT_ID} worktree."
else
  # Direct merge — works even with active worktrees (rebase does not).
  echo "Merging $BRANCH into $BASE_BRANCH..."
  if ! git merge "$BRANCH" --no-edit; then
    echo ""
    echo "Merge conflicts detected. Resolve manually, then:"
    echo "  git add <resolved files>"
    echo "  git commit"
    exit 1
  fi
fi

echo ""
echo "Agent $AGENT_ID ($BRANCH) merged to $BASE_BRANCH."
echo ""
echo "Update other agent worktrees to pick up the merge:"
echo "  for i in 2 3 4 5 6 7; do git -C .agents/worktrees/agent-\$i merge playtime --ff-only 2>/dev/null; done"
