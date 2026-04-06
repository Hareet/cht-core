# CHT PostgreSQL Migration — Agent Instructions

You are an AI agent working on the CHT (Community Health Toolkit) CouchDB-to-PostgreSQL migration. You are one of up to 7 parallel agents, each working in an isolated git worktree on a specific subsystem.

## Your Identity

Read your environment variables to determine your assignment:
- `AGENT_ID` — your numeric ID (1-7)
- `AGENT_NAME` — your task name (e.g., "cht-datasource", "sentinel")

Your task assignment is at: `/workspace/cht-core/.agents/tasks/agent-assignments/agent-{AGENT_ID}-{AGENT_NAME}.md`

## Rules

1. **Stay in your lane.** Only modify files within your assigned scope. Read anything you need, but write only within your designated directories.
2. **Commit early and often.** Every meaningful change gets a commit on your branch (`playtime-agent-{ID}-{NAME}`). Ralph wiggum loops depend on seeing your progress via git history.
3. **LOCAL GIT ONLY.** You have NO remote access. Do not run `git push`, `git fetch`, `git pull`, `git remote`, or any command that contacts a remote. All remotes are blocked at the network, git config, and hook levels. Your work stays local — the human operator handles all remote operations.
4. **Never force-push.** Your branch is yours, but force-pushing loses history that loops and humans rely on.
5. **Check the phase gate.** Some tasks require services that aren't available until a specific phase. Run `/workspace/cht-core/.devcontainer/scripts/phase-gate.sh check <phase>` before attempting service-dependent work. If blocked, work on unit-testable code first.
6. **Signal, don't block.** If you need an image rebuild, `touch /workspace/cht-core/.agents/signals/build-request-agent-{ID}`. If your task is done, write a `DONE.md` at your worktree root.
7. **Use existing patterns.** CHT uses CommonJS modules, npm workspaces, mocha/chai for tests. Match what's already there.
8. **Don't install global packages** or modify `package.json` in shared-libs unless that's your assigned task.
9. **No GitHub/external access.** You cannot reach github.com, npm registry auth tokens, or any external service except the CHT services on `cht-net`. This is by design.

## Migration Context

Read these files for full background (in order of priority):
1. `/workspace/cht-core/CLAUDE.md` — Architecture overview, decision log, PowerSync gaps, timeline (root — auto-discovered by Claude Code)
2. `/workspace/cht-core/context/DECISIONS_AND_CONSTRAINTS.md` — Hard constraints and rationale
3. `/workspace/cht-core/context/IMPLEMENTATION_GUIDE.md` — PostgreSQL schemas, Sync Streams YAML, purge preprocessing
4. `/workspace/cht-core/context/RESEARCH_DISCOVERY_LOG.md` — Investigation path and rejected approaches
5. `/workspace/cht-core/context/POWERSYNC_ANALYSIS.md` — PowerSync vs Custom REST Sync comparison
6. `/workspace/cht-core/context/CHT_ARCHITECTURE_ROADMAP.md` — Official 2026-2027 migration roadmap

## Architecture Summary

```
Current: CouchDB → PouchDB (client) via custom v5 replication
Target:  PostgreSQL → PowerSync SDK + wa-sqlite (client) via Sync Streams
Bridge:  cht-sync (couch2pg) runs during transition
```

Key insight: CHT v5 already decoupled from CouchDB sync. The API layer abstracts database access via `cht-datasource`. Swapping the backend is feasible without rewriting client sync.

## Available Services (by phase)

| Service | Hostname | Port | Phase |
|---------|----------|------|-------|
| CouchDB | couchdb | 5984 | 0 |
| HAProxy | haproxy | 5984 | 1 |
| API | api | 5988 | 1 |
| Sentinel | sentinel | — | 1 |
| Nginx | nginx | 80/443 | 1 |
| PostgreSQL | postgres | 5432 | 2 |
| cht-sync | cht-sync | — | 2 |
| PowerSync | powersync | 8080 | 3 |

## Testing

- **Unit tests** (Phase 0): `npm run unit-api`, `npm run unit-sentinel`, `npm run unit-shared-lib`
- **Integration** (Phase 1+): Services are already running. Connect via hostname. Do NOT call `docker compose` — you have no Docker access.
- **Dev mode** (any phase): Run `npm run dev-api` or `npm run dev-sentinel` from your worktree to start services locally using the shared CouchDB/PostgreSQL.

## Task Coordination

- **Task Registry**: `/workspace/cht-core/.agents/tasks/TASK_REGISTRY.md` — check for dependencies
- **Signals directory**: `/workspace/cht-core/.agents/signals/`
  - `stop-agent-{ID}` — stop your ralph loop
  - `pause-agent-{ID}` — pause your ralph loop
  - `build-request-agent-{ID}` — request image rebuild from human
  - `failed-agent-{ID}` — last failure exit code (written by ralph loop)
- **Logs**: `/workspace/cht-core/.agents/logs/agent-{ID}-ralph.log`

## MCP Servers (if configured)

| Server | Use For |
|--------|---------|
| `cht-core-wiki` | Replication logic, cht-datasource, rules engine, Sentinel |
| `cht-sync-wiki` | couch2pg pipeline, dbt models, PostgreSQL schema |
| `cht-conf-wiki` | Configuration compilation, purge.js, tasks.js |
| PowerSync Docs MCP | Sync Streams syntax, SDK APIs, deployment config |

## PowerSync Skills

If your task involves PowerSync, load `/workspace/cht-core/.agents/skills/powersync/AGENTS.md` before starting. Follow the CLI-first playbook. Key rules:
- Use Sync Streams (not legacy Sync Rules)
- Never define `id` column in PowerSync table schema
- `connect()` is fire-and-forget; use `waitForFirstSync()` for readiness
- `transaction.complete()` is mandatory
