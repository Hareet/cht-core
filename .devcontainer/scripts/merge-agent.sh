#!/bin/bash
# Merge an agent's worktree branch back to the playtime base branch.
# Run on HOST by the human operator.
#
# Usage:
#   ./merge-agent.sh <agent-id>           # Rebase + fast-forward merge
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

# Find the agent's branch
BRANCH=$(git worktree list | grep "agent-${AGENT_ID}" | awk '{print $3}' | tr -d '[]')

if [ -z "$BRANCH" ]; then
  echo "ERROR: No worktree found for agent-${AGENT_ID}"
  echo "Available worktrees:"
  git worktree list
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
  # Rebase agent branch onto latest base
  echo "Rebasing $BRANCH onto $BASE_BRANCH..."
  if ! git rebase "$BASE_BRANCH" "$BRANCH"; then
    echo ""
    echo "Rebase conflicts detected. Resolve manually, then:"
    echo "  git rebase --continue"
    echo "  git checkout $BASE_BRANCH && git merge --ff-only $BRANCH"
    exit 1
  fi

  # Fast-forward merge
  git checkout "$BASE_BRANCH"
  git merge --ff-only "$BRANCH"
fi

echo ""
echo "Agent $AGENT_ID ($BRANCH) merged to $BASE_BRANCH."
echo ""
echo "Consider removing the worktree if done:"
echo "  ./scripts/teardown-worktrees.sh $AGENT_ID"
