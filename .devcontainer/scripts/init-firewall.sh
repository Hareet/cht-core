#!/bin/bash
# Network-level firewall blocking SSH/HTTPS to GitHub.
# Runs at container start with NET_ADMIN capability (optional hardening layer).
# If the container doesn't have NET_ADMIN, this silently skips — the git-level
# protections in the Dockerfile and init-agent-git.sh still apply.

set -uo pipefail

# GitHub's IP ranges (from https://api.github.com/meta)
# We block the well-known SSH and HTTPS endpoints.
GITHUB_HOSTS=(
  "github.com"
  "ssh.github.com"
)

if ! command -v iptables &> /dev/null; then
  echo "[firewall] iptables not available, skipping network-level blocks"
  exit 0
fi

for host in "${GITHUB_HOSTS[@]}"; do
  # Resolve IPs (may fail in restricted DNS environments — that's fine)
  ips=$(getent hosts "$host" 2>/dev/null | awk '{print $1}' || true)
  for ip in $ips; do
    # Block outbound SSH (port 22) and HTTPS (port 443) to GitHub
    iptables -A OUTPUT -d "$ip" -p tcp --dport 22 -j REJECT 2>/dev/null || true
    iptables -A OUTPUT -d "$ip" -p tcp --dport 443 -j REJECT 2>/dev/null || true
    # GitHub also accepts SSH on port 443 via ssh.github.com
    echo "[firewall] Blocked $host ($ip) ports 22,443"
  done
done

echo "[firewall] GitHub network blocks applied (or skipped if no NET_ADMIN)"
