#!/bin/bash
# Initializes git safety for an agent container.
# Runs automatically via the entrypoint in docker-compose.agents.yml.
#
# .git/config is ALREADY hardened by setup-worktrees.sh on the host and
# mounted read-only into the container. This script handles the remaining
# protections that don't require writing to .git/config:
#
#   1. Exports git identity via environment (not config writes)
#   2. Installs a pre-push hook in the worktree's hook dir
#   3. Verifies all protections are active

set -euo pipefail

AGENT_ID=${AGENT_ID:-0}
AGENT_NAME=${AGENT_NAME:-unknown}
WORKTREE_DIR="${PWD}"

echo "[agent-$AGENT_ID] Initializing git safety..."

# 1. Agent identity via environment variables
# These override any git config without needing write access to .git/config.
# Exported so they persist for all git commands in the container session.
export GIT_AUTHOR_NAME="CHT Agent ${AGENT_ID} (${AGENT_NAME})"
export GIT_AUTHOR_EMAIL="agent-${AGENT_ID}@cht-migration.local"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

# Write these to the agent's bashrc so they persist across exec sessions
cat >> /home/agent/.bashrc << EOF
export GIT_AUTHOR_NAME="CHT Agent ${AGENT_ID} (${AGENT_NAME})"
export GIT_AUTHOR_EMAIL="agent-${AGENT_ID}@cht-migration.local"
export GIT_COMMITTER_NAME="\$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="\$GIT_AUTHOR_EMAIL"
EOF

# 2. Install a pre-push hook in the worktree's own hooks directory
# Use git rev-parse which correctly resolves relative paths in the .git file.
HOOKS_DIR="$(git rev-parse --git-dir)/hooks"
mkdir -p "$HOOKS_DIR"
cat > "$HOOKS_DIR/pre-push" << 'HOOK'
#!/bin/bash
echo "========================================"
echo "  BLOCKED: Agents cannot push to any remote."
echo "  All work stays local in your worktree."
echo "  The human operator handles all pushes."
echo "========================================"
exit 1
HOOK
chmod +x "$HOOKS_DIR/pre-push"

# 3. Verify protections
echo "[agent-$AGENT_ID] Git safety checks:"

# Check .git/config has hardened remotes (set by setup-worktrees.sh on host)
REMOTE_URL=$(git config remote.origin.url 2>/dev/null || echo "not set")
echo "  remote.origin.url = $REMOTE_URL"
if [[ "$REMOTE_URL" == *"github.com"* ]]; then
  echo "  WARNING: Remote still points to GitHub! .git/config may not be hardened."
  echo "  Run setup-worktrees.sh on the host to fix."
else
  echo "  [OK] Remote does not point to GitHub"
fi

# Check system-level push blocks (set in Dockerfile)
PUSH_BLOCK=$(git config --system url.error://push-blocked-by-policy.pushInsteadOf 2>/dev/null || echo "not set")
echo "  system pushInsteadOf = $PUSH_BLOCK"
if [ "$PUSH_BLOCK" != "not set" ]; then
  echo "  [OK] System-level push block active"
else
  echo "  WARNING: System-level push block missing"
fi

# Check pre-push hook
if [ -x "$HOOKS_DIR/pre-push" ]; then
  echo "  [OK] Pre-push hook installed at $HOOKS_DIR/pre-push"
else
  echo "  WARNING: Pre-push hook not executable"
fi

# Check no SSH keys present
if ls /home/agent/.ssh/id_* 2>/dev/null | grep -q .; then
  echo "  WARNING: SSH keys found in agent home!"
else
  echo "  [OK] No SSH keys present"
fi

echo "  identity = $GIT_AUTHOR_NAME <$GIT_AUTHOR_EMAIL>"
echo ""
echo "[agent-$AGENT_ID] Git safety initialized."
