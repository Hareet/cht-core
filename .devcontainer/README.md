# CHT PostgreSQL Migration — Multi-Agent Development Environment

A containerized setup for running parallel Claude Code agents against a live CHT stack to complete the CouchDB-to-PostgreSQL refactor on the `playtime` branch.

Up to 7 agents work in isolated git worktrees, sharing a Docker network with progressively deployed services. A human operator controls all phase transitions, image builds, remote git operations, and the merge queue.

---

## Getting Started

### Prerequisites

- Docker and Docker Compose v2 installed
- CouchDB already running on `cht-net` (the existing `~/cht-docker` setup)
- The `playtime` branch checked out in this repo
- Node.js 22.15+ and npm 10.9+ on the host (for `npm run local-images`)

### 1. Create the environment file

```bash
cd .devcontainer
cp .env.example .env
```

Edit `.env` with real values. At minimum, set `COUCHDB_PASSWORD` to match your `~/cht-docker` setup. The `CHT_CORE_PATH` and `CHT_AI_TOOLS_PATH` defaults match the standard layout at `~/ai_medic/`.

### 2. Create agent worktrees and harden git

```bash
# From the repo root:
.devcontainer/scripts/setup-worktrees.sh
```

This does two things:
- Creates a git worktree per agent branching from `playtime` (e.g., `playtime-agent-1-cht-datasource`)
- **Hardens `.git/config`** — overwrites all remote URLs to `/dev/null` and saves the real URL to `.git/.real-remote-url` for later restoration

You can create a subset of worktrees instead:

```bash
.devcontainer/scripts/setup-worktrees.sh 1 4 7    # just agents 1, 4, 7
```

### 3. Build the agent image and start containers

```bash
cd .devcontainer

# Start all 7 agents:
docker compose -f docker-compose.agents.yml up -d

# Or start a subset:
docker compose -f docker-compose.agents.yml up -d agent-1 agent-4 agent-7
```

Each container runs `init-agent-git.sh` on startup, which installs pre-push hooks and verifies all security layers. You'll see the verification output in `docker logs cht-agent-1`.

### 4. Verify connectivity and security

```bash
# Agents should reach CouchDB on the shared network:
docker exec cht-agent-1 curl -s http://admin:secret@couchdb:5984/ | head -1

# Check all security layers passed:
docker logs cht-agent-1 2>&1 | grep -A 10 "Git safety checks"
```

### 5. Claude Code authentication

Agents share your Max plan OAuth credentials. You log in **once on the host** — all containers inherit the token via a read-only mount of `~/.claude/.credentials.json`.

```bash
# On the host (one time):
claude login
```

This writes `~/.claude/.credentials.json`. The compose file mounts it read-only into every agent at `/home/agent/.claude/.credentials.json`. No per-agent login needed.

Verify from inside a container:

```bash
docker exec -it cht-agent-1 claude --version
docker exec -it cht-agent-1 claude -p "Say hello"
```

### 6. Run Claude Code on an agent's task

Each agent has a task assignment at `.agents/tasks/agent-assignments/agent-N-*.md`. Start an agent interactively or in a ralph loop:

```bash
# Interactive — attach and run Claude Code in the worktree:
docker exec -it cht-agent-1 claude

# Autonomous — ralph loop runs Claude Code repeatedly with backoff:
docker exec -d cht-agent-1 \
  /workspace/cht-core/.devcontainer/scripts/ralph-loop.sh 1 \
  "claude -p 'Read your task at .agents/tasks/agent-assignments/agent-1-cht-datasource.md and continue working. Commit progress.'" \
  300 1800
```

Claude Code discovers the root `CLAUDE.md` and `.agents/CLAUDE.md` automatically, giving the agent full migration context.

Or attach VS Code to any running agent container via "Attach to Running Container".

---

## Phase Deployment — What You Deploy and When

Services are brought up in phases. Each phase requires you to manually start the compose stack and approve the gate. Agents can check the current phase and block-wait for a phase they need.

### Phase 0: Agents + CouchDB (immediate)

Already running after steps 1-4. Agents can:
- Run unit tests (`npm run unit-api`, `npm run unit-sentinel`, `npm run unit-shared-lib`)
- Lint (`npm run lint`)
- Explore and modify code in their worktrees
- Commit to their local branches

### Phase 1: CHT Stack (haproxy, api, sentinel, nginx)

**What you're checking**: Can agents run integration tests against the full CHT application?

```bash
# Build CHT images from the host (agents can't do this):
cd ~/ai_medic/cht-core
npm run local-images

# Start the CHT stack:
cd .devcontainer
docker compose -f docker-compose.services.yml up -d

# Wait for the API to be ready (polls /api/info):
docker exec cht-agent-1 bash -c \
  '/workspace/cht-core/.devcontainer/scripts/health-check.sh --wait'

# Approve the gate:
./scripts/phase-gate.sh approve 1
```

**Verify**: `curl -k https://localhost/api/info` returns the CHT version.

### Phase 2: PostgreSQL + cht-sync

**What you're checking**: Is PostgreSQL accepting connections? Is cht-sync replicating CouchDB data into it?

```bash
docker compose -f docker-compose.postgres.yml up -d

# Wait for PG health check:
docker exec cht-postgres pg_isready -U cht -d cht

# Approve:
./scripts/phase-gate.sh approve 2
```

**Verify**:
```bash
# From an agent container — PG is reachable:
docker exec cht-agent-1 psql -h postgres -U cht -d cht -c 'SELECT 1'

# cht-sync is populating the couchdb table:
docker exec cht-agent-1 psql -h postgres -U cht -d cht \
  -c "SELECT count(*) FROM couchdb"
```

### Phase 3: PowerSync Service

**What you're checking**: Is PowerSync connecting to PostgreSQL's WAL and serving the diagnostics endpoint?

```bash
docker compose -f docker-compose.powersync.yml up -d

# Verify diagnostics:
curl http://localhost:8080/api/admin/v1/diagnostics \
  -H "Authorization: Bearer $POWERSYNC_ADMIN_TOKEN"

# Approve:
./scripts/phase-gate.sh approve 3
```

### Checking phase status

```bash
./scripts/phase-gate.sh status
```

---

## Security Model — 5 Layers of Git/GitHub Protection

Agents have **zero access** to GitHub, your SSH keys, your git identity, or any remote repository. This is enforced at 5 independent layers. Any single layer is sufficient; all 5 are active simultaneously.

### Layer 1: No credentials enter the container

| What's blocked | How |
|---------------|-----|
| SSH keys (`~/.ssh/id_rsa`) | Never mounted — not in any volumes list |
| Your gitconfig (`~/.gitconfig`) | Never mounted — agent gets a blank identity |
| GitHub tokens | Never mounted — no `GH_TOKEN`, `GITHUB_TOKEN`, etc. |
| Docker socket | Never mounted — agents can't manage containers |

The compose file only mounts: the cht-core repo (`rw`), cht-ai-tools (`ro`), and named volumes for `node_modules`/npm cache. Nothing from your home directory.

### Layer 2: System-level git config (baked into image)

Set in the **Dockerfile** at `--system` level. Requires root to change — the `agent` user cannot modify it.

```
pushInsteadOf "git@github.com:"     → "error://push-blocked-by-policy"
pushInsteadOf "https://github.com/" → "error://push-blocked-by-policy"
pushInsteadOf "ssh://git@github.com/" → "error://push-blocked-by-policy"
credential.helper = ""
push.default = nothing
```

Even if an agent somehow obtained credentials and modified `.git/config`, git still rewrites all GitHub push URLs to an invalid `error://` protocol at the system level.

### Layer 3: `.git/config` hardened and mounted read-only

`setup-worktrees.sh` runs **on the host** and rewrites `.git/config`:
- All `remote.*.url` and `remote.*.pushurl` → `/dev/null`
- Adds local `pushInsteadOf` blocks for GitHub URL patterns
- Saves the real URL to `.git/.real-remote-url` for restoration

The compose file then mounts `.git/config` as **read-only** (`:ro`) into every container:
```yaml
- ${CHT_CORE_PATH}/.git/config:/workspace/cht-core/.git/config:ro
```

The agent cannot edit this file. The filesystem enforces it.

### Layer 4: Pre-push hook and environment identity

`init-agent-git.sh` runs automatically on container start via the entrypoint:
- Installs a `pre-push` hook in the worktree's hooks directory that hard-blocks all pushes with a clear error
- Sets `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` via environment variables to a dummy identity (`agent-1@cht-migration.local`)
- Writes these to `~/.bashrc` so they persist across `docker exec` sessions
- Runs a verification check reporting the status of all layers

### Layer 5: Agent instructions (`.agents/CLAUDE.md`)

Rule 3 in the agent CLAUDE.md:

> **LOCAL GIT ONLY.** You have NO remote access. Do not run `git push`, `git fetch`, `git pull`, `git remote`, or any command that contacts a remote.

Rule 9:

> **No GitHub/external access.** You cannot reach github.com, npm registry auth tokens, or any external service except the CHT services on `cht-net`.

### Optional: Network-level firewall

If you grant `NET_ADMIN` capability to agent containers, `init-firewall.sh` adds iptables rules blocking outbound TCP to GitHub IPs on ports 22 and 443. This is not enabled by default — the other 5 layers are sufficient.

### Restoring your git config

When **you** need to push from the host:

```bash
# Restore:
.devcontainer/scripts/restore-git-config.sh

# Check current state:
.devcontainer/scripts/restore-git-config.sh --check

# Re-harden after you're done:
.devcontainer/scripts/setup-worktrees.sh
```

---

## File Reference — What Everything Does

### Container Infrastructure

| File | Purpose |
|------|---------|
| `Dockerfile` | Agent container image. Node 22, pg-client, build tools, system-level git security hardening, non-root `agent` user with no SSH keys. |
| `devcontainer.json` | VS Code attach configuration. Pre-configured for agent-1; works with any agent container via "Attach to Running Container". |
| `docker-compose.agents.yml` | Defines up to 7 agent containers. Each gets: bind-mounted repo with read-only `.git/config`, named volume for `node_modules`, shared npm cache, connection to `cht-net`, 4GB memory limit. Entrypoint runs `init-agent-git.sh` then sleeps. |
| `docker-compose.services.yml` | Phase 1 CHT stack: haproxy, api, sentinel, nginx. Matches the patterns from `scripts/build/cht-core.yml.template`. References locally-built images from `npm run local-images`. |
| `docker-compose.postgres.yml` | Phase 2: PostgreSQL 16 with tuned settings (`wal_level=logical`, `jit=off`, `work_mem=20MB`) and cht-sync bridge. Exposes port 5432 for host-side tooling. |
| `docker-compose.powersync.yml` | Phase 3: Self-hosted PowerSync Service reading PostgreSQL WAL. Config mounted from `powersync-config/`. |
| `.env.example` | Template for shared environment variables. Copy to `.env` and fill in passwords, paths, version. |

### Orchestration Scripts

All scripts live in `scripts/` and are executable. Scripts marked **(HOST)** must run on the host machine, not inside containers.

| Script | Where | What it does |
|--------|-------|-------------|
| `setup-worktrees.sh` | HOST | Creates git worktrees for agents from the `playtime` branch. Hardens `.git/config` (overwrites remotes to `/dev/null`, saves real URL). Idempotent — won't recreate existing worktrees. |
| `teardown-worktrees.sh` | HOST | Removes agent worktrees. Warns on uncommitted changes and prompts for confirmation before deleting. |
| `init-agent-git.sh` | Container | Runs on container start. Sets agent identity via env vars, installs pre-push hook, verifies all 5 security layers are active. Does NOT write to `.git/config` (it's read-only). |
| `init-firewall.sh` | Container | Optional network-level iptables rules blocking GitHub IPs. Silently skips if `NET_ADMIN` capability not granted. |
| `phase-gate.sh` | Both | Human intervention gate. `approve <N>` advances the phase. `check <N>` tests if a phase is active (agents use this). `wait <N>` blocks until approved. `status` shows current state. |
| `health-check.sh` | Container | Tests service connectivity. Automatically checks services appropriate for the current phase. `--wait` mode polls until all services are ready (5-minute timeout). |
| `ralph-loop.sh` | Container | Runs a command on repeat with configurable interval and timeout. The timeout (default 30 min) is critical for Claude Code: when a rate limit is hit, the CLI stalls indefinitely (no exit, no countdown). The timeout kills the stalled process so the loop can check signals and retry with exponential backoff (300s → 600s → 1200s → ... capped at 1 hour). Stop: `touch .agents/signals/stop-agent-N`. Pause: `touch .agents/signals/pause-agent-N`. Logs to `.agents/logs/`. |
| `merge-agent.sh` | HOST | Merges an agent's worktree branch back to `playtime`. Shows commits and changed files, prompts for confirmation. Supports rebase+fast-forward (default) or `--squash`. |
| `restore-git-config.sh` | HOST | Restores `.git/config` to the real remote URL so you can push/fetch. Run `setup-worktrees.sh` again to re-harden. |

### Agent Coordination

| File | Purpose |
|------|---------|
| `.agents/CLAUDE.md` | Shared context loaded by every agent on startup. Contains: rules (including git restrictions), migration architecture summary, service table by phase, testing commands, signal file conventions, MCP server routing. |
| `.agents/tasks/TASK_REGISTRY.md` | Central tracking: agent assignments, branch names, phase dependencies, merge order, dependency graph, file ownership table. The human maintains this; agents read it. |
| `.agents/tasks/agent-assignments/agent-N-*.md` | Per-agent assignment with: objective, scope (which directories to write), phase dependency, task checklist, key context files to read, success criteria. |
| `.agents/signals/` | File-based signaling directory (gitignored). Touch `stop-agent-N`, `pause-agent-N`, or `build-request-agent-N` to control agents. |
| `.agents/logs/` | Ralph loop logs (gitignored). One log file per agent: `agent-N-ralph.log`. |
| `.agents/worktrees/` | Git worktree directories (gitignored). One per agent: `agent-N/`. |

---

## Human Operator Workflow

Your role is the control plane: you manage service lifecycle, git remotes, image builds, and the merge queue. Agents handle code, tests, and commits.

### Daily operations

| When | What you do |
|------|-------------|
| Session start | `docker compose -f docker-compose.agents.yml up -d` (or a subset) |
| Agent needs an image rebuild | Check `.agents/signals/build-request-agent-N`, then `npm run local-images` on host + restart services |
| Advancing a phase | Start the compose stack, verify services, `./scripts/phase-gate.sh approve N` |
| Checking agent progress | `docker exec cht-agent-N git log --oneline -10` or `tail .agents/logs/agent-N-ralph.log` |
| Pausing an agent's loop | `touch .agents/signals/pause-agent-N` (remove the file to resume) |
| Stopping an agent's loop | `touch .agents/signals/stop-agent-N` |
| Merging agent work | `./scripts/merge-agent.sh N` (follow the merge order in the task registry) |
| Pushing to GitHub | `./scripts/restore-git-config.sh`, then `git push`, then `./scripts/setup-worktrees.sh` to re-harden |
| Session end | `docker compose -f docker-compose.agents.yml down` (services can keep running) |

### What you're verifying at each gate

| Gate | You're checking |
|------|----------------|
| Phase 0 → 1 | CHT images built successfully. API starts and responds at `/api/info`. Sentinel connects to CouchDB. Nginx serves HTTPS. |
| Phase 1 → 2 | PostgreSQL accepts connections. `wal_level=logical` is set (required for PowerSync). cht-sync starts replicating — `SELECT count(*) FROM couchdb` returns rows. |
| Phase 2 → 3 | PowerSync diagnostics endpoint returns healthy. It's reading the WAL. Sync config is deployed. |
| Build request | Agent's code changes require a new Docker image. Build, restart the relevant service, verify it starts. |
| Merge | Agent wrote `DONE.md` in their worktree. Tests pass. Changes stay within the agent's assigned scope. No dependency conflicts with previously merged agents. |
| Push | All merged work on `playtime` passes tests. You're ready to share with the team. |

### Merge order

Based on the dependency graph in the task registry:

```
1. Agent 1 (cht-datasource)  — foundation, merge first
2. Agent 4 (purge-preproc)   — parallel with Agent 1, independent files
3. Agent 2 (sentinel)        — depends on Agent 1's adapter
4. Agent 7 (integration)     — validates Agents 1 + 2
5. Agent 3 (sync-streams)    — independent config, no code overlap
6. Agent 5 (powersync-sdk)   — client-side, independent of server agents
7. Agent 6 (rules-engine)    — depends on Agent 5's PowerSync integration
```

After each merge, other agents with dependencies should rebase:
```bash
# Inside the dependent agent's container:
git rebase playtime
```

---

## Stopping and Cleaning Up

```bash
# Stop agents (preserves worktrees and volumes):
cd .devcontainer
docker compose -f docker-compose.agents.yml down

# Stop all services:
docker compose -f docker-compose.services.yml down
docker compose -f docker-compose.postgres.yml down
docker compose -f docker-compose.powersync.yml down

# Remove agent worktrees (prompts if uncommitted changes):
./scripts/teardown-worktrees.sh

# Restore git config to push your work:
./scripts/restore-git-config.sh

# Clean up named volumes (destroys node_modules caches):
docker volume prune
```
