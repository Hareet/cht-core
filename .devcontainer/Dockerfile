FROM node:22-bookworm

# System dependencies matching CHT build requirements
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    build-essential \
    python3 \
    libxslt-dev \
    shellcheck \
    postgresql-client \
    iptables \
    && rm -rf /var/lib/apt/lists/*

# --- Git/GitHub security hardening ---

# Block SSH to GitHub at the network level (iptables)
COPY scripts/init-firewall.sh /usr/local/bin/init-firewall.sh
RUN chmod +x /usr/local/bin/init-firewall.sh

# Remove any SSH client config that might exist in the base image
RUN rm -rf /root/.ssh /etc/ssh/ssh_config.d/ 2>/dev/null || true

# Global git config: block GitHub URLs for ALL users in the container
RUN git config --system url."error://push-blocked-by-policy".pushInsteadOf "git@github.com:" && \
    git config --system url."error://push-blocked-by-policy".pushInsteadOf "https://github.com/" && \
    git config --system url."error://push-blocked-by-policy".pushInsteadOf "ssh://git@github.com/" && \
    git config --system credential.helper "" && \
    git config --system transfer.fsckObjects true

# Create non-root agent user (no sudo, no SSH keys)
# uid 1000 matches the typical host user so bind-mounted files are writable.
# The node:22 base image has a 'node' user at uid 1000 — remove it first.
RUN userdel -r node 2>/dev/null || true && \
    useradd -m -s /bin/bash -u 1000 agent

# Ensure agent user has no SSH directory and cannot create one in standard locations
RUN mkdir -p /home/agent/.ssh && \
    echo "# SSH disabled for agent containers" > /home/agent/.ssh/config && \
    chmod 444 /home/agent/.ssh/config && \
    chown root:root /home/agent/.ssh /home/agent/.ssh/config

# --- Install Claude Code CLI (as root, before switching to agent user) ---
RUN npm install -g @anthropic-ai/claude-code

# Set up workspace and claude config directories
RUN mkdir -p /workspace/cht-core /workspace/worktree /workspace/cht-ai-tools \
    /home/agent/.claude \
    && chown -R agent:agent /workspace /home/agent/.claude

USER agent

ENV CLAUDE_CONFIG_DIR=/home/agent/.claude
ENV NODE_OPTIONS="--max-old-space-size=4096"

WORKDIR /workspace/worktree

# Agent-level git config: dummy identity, no credential helpers
# safe.directory entries required for bind-mounted files owned by host uid.
RUN git config --global user.name "CHT Migration Agent" && \
    git config --global user.email "agent@cht-migration.local" && \
    git config --global credential.helper "" && \
    git config --global push.default nothing && \
    git config --global --add safe.directory /workspace/cht-core && \
    git config --global --add safe.directory /workspace/cht-core/.agents/worktrees/agent-1 && \
    git config --global --add safe.directory /workspace/cht-core/.agents/worktrees/agent-2 && \
    git config --global --add safe.directory /workspace/cht-core/.agents/worktrees/agent-3 && \
    git config --global --add safe.directory /workspace/cht-core/.agents/worktrees/agent-4 && \
    git config --global --add safe.directory /workspace/cht-core/.agents/worktrees/agent-5 && \
    git config --global --add safe.directory /workspace/cht-core/.agents/worktrees/agent-6 && \
    git config --global --add safe.directory /workspace/cht-core/.agents/worktrees/agent-7

# Global npm tools path
RUN npm config set prefix /home/agent/.npm-global
ENV PATH="/home/agent/.npm-global/bin:$PATH"

# Keep container alive for exec
CMD ["sleep", "infinity"]
