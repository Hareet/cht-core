# Session Summary: CHT PostgreSQL Migration — Multi-Agent Refactor

**Date**: April 7, 2026  
**Duration**: ~12 hours (design through merge)  
**Branch**: `playtime` on `github.com/Hareet/cht-core`  
**Result**: All 7 agents completed, all work merged, 2,727+ tests passing, zero failures

---

## What We Built

A containerized multi-agent development environment that ran 7 parallel Claude Code agents to execute the CHT CouchDB-to-PostgreSQL migration refactor. Each agent worked in an isolated git worktree, connected to progressively deployed CHT services via a shared Docker network, coordinated by a human operator at phase transitions.

### Deliverables Merged to `playtime`

| Agent | Deliverable | Key Files |
|-------|------------|-----------|
| 1 | PostgreSQL adapter for cht-datasource | `shared-libs/cht-datasource/src/local/libs/postgres/` |
| 2 | Sentinel PostgreSQL backend with feature flag | `sentinel/src/` modifications |
| 3 | PowerSync Sync Streams YAML (contacts, reports, tasks, targets, global config, user meta) | `.devcontainer/powersync-config/` |
| 4 | Purge preprocessing service (purge.js → purge_status table) | `services/purge-preproc/` (new) |
| 5 | PowerSync Web SDK Angular integration with dev auth | `webapp/src/ts/services/powersync/` |
| 6 | Rules engine PowerSync/SQLite adapter | `shared-libs/rules-engine/` modifications |
| 7 | 61 live integration tests for PostgreSQL code paths | `tests/` additions |

### Infrastructure Created

| Component | Purpose |
|-----------|---------|
| `.devcontainer/Dockerfile` | Agent container: Node 22, Claude Code CLI, git security hardening, pg-client |
| `.devcontainer/docker-compose.agents.yml` | 7 agent containers with worktree mounts, shared Claude auth volume |
| `.devcontainer/docker-compose.services.yml` | Phase 1: CHT stack (haproxy, api, sentinel, nginx) |
| `.devcontainer/docker-compose.postgres.yml` | Phase 2: PostgreSQL 16 + couch2pg from cht-sync |
| `.devcontainer/docker-compose.powersync.yml` | Phase 3: Self-hosted PowerSync Service |
| `.devcontainer/scripts/` | 9 orchestration scripts (worktrees, phase gates, ralph loops, merge, health checks) |
| `.agents/CLAUDE.md` | Shared agent context with research workflow, MCP routing, tool selection guide |
| `.agents/tasks/` | Task registry + 7 per-agent assignment files with scope, success criteria |
| `.mcp.json` | 6 MCP servers (4 OpenDeepWiki, Kapa docs, PowerSync docs) |
| `.claude/settings.json` | Allowed/denied tool permissions for autonomous operation |

---

## How This Maps to the CHT-Agent Hierarchical Multi-Agent System

The [medic/cht-agent](https://github.com/medic/cht-agent) design document describes a hierarchical multi-agent system built on LangChain/LangGraph with specialized supervisors and worker agents. This session **manually executed that exact architecture** using Claude Code containers in place of the programmatic orchestration layer. Every component from the cht-agent design was present — implemented through human coordination, structured prompts, and file-based signaling rather than LangGraph state machines.

### Architecture Mapping

```
cht-agent Design (Planned)              This Session (Executed)
═══════════════════════════              ═══════════════════════
                                        
CLI Interface                           Human operator terminal
    ↓                                       ↓
Master Supervisor (Orchestrator)        Claude Code (this conversation)
├── Research Supervisor                 ├── Phase 0: Research prompts to agents
│   ├── Documentation Search Agent      │   ├── MCP servers (cht-core-wiki, cht-kapa-docs)
│   └── Context Analysis Agent          │   └── Context docs (IMPLEMENTATION_GUIDE, DECISIONS)
│                                       │
├── [HUMAN VALIDATION CHECKPOINT #1]    ├── Phase gates (approve 1, 2, 3)
│                                       │
├── Development Supervisor              ├── Phase 1-3: Implementation prompts
│   ├── Code Generation Agent           │   ├── Agents 1-6 writing code
│   └── Test Environment Agent          │   └── Docker services (CouchDB, PG, PowerSync)
│                                       │
├── QA Supervisor                       ├── Agent 7 (integration tests)
│   ├── Code Validation Agent           │   ├── npm run unit (2,727 tests)
│   └── Test Orchestration Agent        │   └── Merge-time validation
│                                       │
└── [HUMAN VALIDATION CHECKPOINT #2]    └── merge-agent.sh + test suite verification
```

### Component-by-Component Correlation

#### 1. Master Supervisor → This Claude Code Conversation

The cht-agent design describes a Master Supervisor that "routes tasks to appropriate supervisors based on GitHub issue analysis, maintains global task queue and workflow state, and coordinates cross-functional requirements."

**What we did**: This conversation session served as the Master Supervisor. We:
- Decomposed the migration into 7 discrete tasks with dependency ordering
- Created the `.agents/tasks/TASK_REGISTRY.md` as the global task queue
- Routed tasks to specialized agents via structured assignment files
- Managed cross-functional requirements through the merge order (Agent 1 before Agent 2, Agent 5 before Agent 6)
- Coordinated phase transitions as the human-in-the-loop checkpoint

#### 2. Research Supervisor → Phase 0 Agent Prompts + MCP Servers

The cht-agent design has a Research Supervisor with Documentation Search and Context Analysis sub-agents that use "cht-docs as a tool or full context of cht-docs and a search tool."

**What we did**: Each agent's first task was research — prompted to:
1. Read context documents first (our equivalent of the Context Analysis Agent)
2. Query MCP servers at equal priority with local code reading (our equivalent of the Documentation Search Agent)
3. Collate findings across sources and verify with MCPs before implementing

The `.agents/CLAUDE.md` research workflow section encoded this exact pattern:
> "Read context docs first → Query MCP servers and read local code together → Collate across sources"

**MCP servers as the cht-agent toolkit**:
| cht-agent Tool | This Session's MCP |
|----------------|-------------------|
| cht-docs search | `cht-kapa-docs` (ask_question) |
| cht-core code analysis | `cht-core-wiki` (search_documents → read_document) |
| cht-conf reference | `cht-conf-wiki` |
| cht-sync pipeline | `cht-sync-wiki` |
| PowerSync reference | `powersync-docs` + local skills files |

#### 3. Development Supervisor → Phased Agent Prompts with Guard Rails

The cht-agent design has a Development Supervisor with Code Generation and Test Environment sub-agents. The Code Generation Agent "generates code following CHT patterns from context files" and "adheres to CHT coding standards by default."

**What we did**: Each agent's assignment file (`.agents/tasks/agent-assignments/agent-N-*.md`) served as the structured task template — equivalent to the cht-agent's issue template format:
- **Objective**: What to build
- **Scope**: Which directories to write (file ownership guard rail)
- **Phase Dependency**: When the agent can test against live services
- **Tasks**: Ordered subtask checklist
- **Key Context**: Which documents and MCP servers to consult
- **Success Criteria**: What "done" looks like

The phase gate system (`phase-gate.sh`) served as the Test Environment Agent — controlling when services were available for testing, ensuring agents didn't attempt integration work before infrastructure was ready.

#### 4. QA Supervisor → Agent 7 + Merge-Time Validation

The cht-agent design has a QA Supervisor with Code Validation and Test Orchestration sub-agents that "orchestrate linting and compiling, run Shellcheck, validate CHT coding standards, and intelligently select test suites."

**What we did**:
- **Agent 7** was explicitly assigned as the integration test writer — the Test Orchestration Agent role, producing 61 live integration tests
- **Merge-time validation**: After all agents merged, we ran `npm run unit` (2,727 tests) as the Code Validation step
- **Agent-5 bug fix cycle**: When webapp tests failed with TypeScript errors, we routed the failure back to Agent 5 for correction — the reflection/iteration loop from the cht-agent Reflection Agent pattern
- **Human review at merge**: `merge-agent.sh` showed commits and file diffs before each merge, serving as the Human Validation Checkpoint #2

#### 5. Human-in-the-Loop Checkpoints → Phase Gates + Merge Queue

The cht-agent design includes two explicit human validation checkpoints:
- **Checkpoint #1**: Post-Research — "Validate research findings, approve orchestration plan"
- **Checkpoint #2**: Post-Implementation — "Review generated code, verify test results, approve for completion"

**What we did**: These checkpoints were implemented as:

| cht-agent Checkpoint | This Session's Equivalent |
|---------------------|--------------------------|
| Post-Research validation | Manually reviewing agent-1's MCP-verified CouchDB call catalog before approving "continue to Task 2" |
| Orchestration plan approval | Phase gate approvals (approve 1, 2, 3) after verifying services were healthy |
| Post-Implementation review | `merge-agent.sh` showing commits + `npm run unit` passing before merge |
| Rejection/iteration | Routing test failures back to Agent 5 for TypeScript fixes |

#### 6. Communication Protocol → File-Based Signaling + Git

The cht-agent design specifies a JSON-based inter-agent communication protocol with structured `AgentMessage` objects containing source, target, message_type, and payload.

**What we did**: Communication was file-based and git-based:
- **`.agents/signals/`**: stop, pause, build-request files (runtime signaling)
- **`.agents/tasks/TASK_REGISTRY.md`**: Central state tracking (the Master Supervisor's task queue)
- **Git commits**: Each agent's progress was visible to the human via `git log --oneline`
- **Worktree merges**: `git merge playtime` in dependent worktrees propagated Agent 1's adapter to Agents 2, 5, 6, 7
- **Guard-railed prompts**: Each prompt to an agent included service connection details, schema names, passwords — the structured payload equivalent

#### 7. Context & Memory System → CLAUDE.md + Context Docs + MCP Servers

The cht-agent design describes a "Dual-Layer Context Architecture" with shared context files mirroring CHT repository structure and agent-specific context for specialized expertise.

**What we did**: Three layers of context:

| cht-agent Context Layer | This Session's Implementation |
|------------------------|------------------------------|
| Shared contexts (CHT architecture) | `CLAUDE.md` (root), `context/` directory (6 research documents) |
| Agent-specific context | Per-agent assignment files with scope, tasks, success criteria |
| Category-based retrieval | MCP server routing table in `.agents/CLAUDE.md` — which server for which question |
| Pattern learning | Agent commits and research summaries persisted in git history |

The cht-agent's `CHTCategory` type system (forms, tasks, targets, reports, workflows, permissions, sync, purging, etc.) maps directly to our agent assignment scoping — Agent 3 handled sync, Agent 4 handled purging, Agent 6 handled tasks/targets, etc.

#### 8. Tool Orchestration → Allowed Tools + Skills + MCP Permissions

The cht-agent design principle: "Agents act as intelligent coordinators of existing CHT tools (cht-conf, cht-toolbox, cht-datasource, cht-docs, npm scripts) rather than implementing custom validation."

**What we did**: `.claude/settings.json` defined the exact tool permissions:
- **Allowed**: npm commands, git (local only), curl, psql, file operations, all 6 MCP servers
- **Denied**: git push/fetch/pull/remote, ssh, docker, rm -rf
- **Skills**: PowerSync agent skills at `.agents/skills/powersync/` providing curated SDK references
- **MCP routing**: `.agents/CLAUDE.md` told agents exactly which MCP to query for which question

This matches the cht-agent toolkit concept — each agent had access to the tools it needed, guard-railed away from tools it shouldn't use.

---

## What We Learned (For cht-agent Implementation)

### 1. The Hierarchical Pattern Works — Even Manually

The cht-agent's hierarchical supervisor pattern proved effective when executed manually. The key insight: **the architecture is sound, the automation layer is an optimization**. We achieved in one session what the cht-agent aims to automate:
- Task decomposition into specialized agents
- Research → Development → QA pipeline
- Human-in-the-loop at critical decision points
- Parallel execution with dependency management

### 2. MCP Servers Are the Right Tool Abstraction

Agents that used MCPs produced more accurate work than those that relied solely on local code reading. The "ask docs first, then verify with code" pattern from `.agents/CLAUDE.md` worked — Agent 1's MCP-verified analysis caught the `contacts_by_reference` view gap that pure code reading missed.

**For cht-agent**: The MCP server integration should be a first-class concern, not an afterthought. The routing table (which MCP for which question) was one of the most valuable pieces of agent context.

### 3. Guard-Railed Prompts Replace Programmatic Routing

Instead of LangGraph routing logic, we used structured prompts that included:
- Connection details (hostnames, ports, passwords, schema names)
- Phase-specific instructions ("Phase 2 is active, PG at postgres:5432")
- Tool usage guidance ("verify against MCP servers before implementing")
- Scope boundaries ("only modify files in shared-libs/cht-datasource/")

**For cht-agent**: The `AgentMessage` protocol can be simplified. The structured prompt IS the message — it contains the task, context, tools, and constraints. The LangGraph state machine routes the prompt, not a separate message protocol.

### 4. File-Based Signaling Is Sufficient for 7 Agents

No Redis, no NATS, no message queue. File-based signals (`.agents/signals/`) and git-based state (commits, merges) handled all inter-agent coordination. The bottleneck was never communication — it was the human reviewing and approving.

**For cht-agent**: Start with file-based communication. The JSON protocol in the design doc is well-structured, but the transport layer can be filesystem-based initially.

### 5. Phase Gates Are Critical for Service Dependencies

Agents blocked on services they didn't have yet was the most common friction point. The phase gate pattern (check → wait → approve) prevented wasted work. Without it, agents would have spent cycles trying to connect to PostgreSQL before it existed.

**For cht-agent**: The Test Environment Agent needs explicit lifecycle management — not just "set up the environment" but "signal when it's ready and prevent other agents from proceeding until it is."

### 6. The Merge Order IS the Dependency Graph

The cht-agent design discusses cross-functional requirements and coordination. In practice, the merge order encoded all dependencies:
1. Foundation (cht-datasource) → 2. Consumers (sentinel, purge) → 3. Validators (integration tests) → 4. Independent (sync streams) → 5. Client (PowerSync SDK) → 6. Final (rules engine)

**For cht-agent**: The Master Supervisor's task queue should be a topologically-sorted dependency graph, not a flat list. Agents that produce interfaces merge before agents that consume them.

### 7. Container Security Is Solvable at 5 Layers

The git/GitHub security model proved robust across 7 agents and 12 hours:
1. No credentials mounted
2. System-level git config (push blocks baked in image)
3. Hardened .git/config (remotes → /dev/null)
4. Pre-push hooks
5. Agent instructions

Zero security incidents. No accidental pushes, no credential leaks, no remote access.

**For cht-agent**: Agent sandboxing is a deployment concern, not an AI concern. The container-level protections we built can be reused directly — the cht-agent just needs to run inside these containers.

---

## What's Next

### Immediate
- Run ralph wiggum loops for the next iteration (refinement, edge cases, coverage gaps)
- `replicate_primary_contacts` already fixed by Agent 3 (commit `f9cbd6d63`) — ancestors, primary contacts, and user contact all replicate correctly
- Set up cht-sync properly for full CouchDB→PG real-time replication testing
- Rebuild CHT images with merged code for end-to-end stack testing

### For cht-agent Development
- This session validated the cht-agent architecture with a real, complex task
- The `.devcontainer/` infrastructure can host cht-agent as a container on the same network
- The `.agents/CLAUDE.md` research workflow can be formalized as the Research Supervisor's prompt template
- The task assignment format can become the cht-agent issue template schema
- The phase gate pattern can be implemented as LangGraph conditional edges

### For the CHT PostgreSQL Migration
- All 7 subsystems have initial implementations on `playtime`
- Phase 2-3 services (PostgreSQL + PowerSync) are running and testable
- The cht-datasource adapter is the foundation — all other agents built on it
- Integration tests validate the core code paths
- Next: stress testing, production data validation, county pilot planning
