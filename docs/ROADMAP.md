# Agentic AI Workspace Roadmap

## Completed

- ✅ AAI-001 Backend Foundation
...
- ✅ AAI-023 Vector Store
- ✅ AAI-024 Hybrid Retrieval
- ✅ AAI-025 Knowledge Ranking
- ✅ AAI-026 Observability
- ✅ AAI-027 Tracing
- ✅ AAI-028 Metrics
- ✅ AAI-029 Caching
- ✅ AAI-030 Security
- ✅ AAI-031 Streaming Responses
- ✅ AAI-032 Human-in-the-Loop
- ✅ AAI-033 Workflow Engine
- ✅ AAI-034 Checkpoint & Recovery
- ✅ AAI-035 Framework Release (v2.0.0)

## Phase 3

- ✅ AAI-036 Persistent Storage Providers — pgvector-backed `VectorStore`
  (drop-in replacement, same interface), plus additive async providers for
  checkpoints (Postgres) and caching (Redis), and a new async knowledge
  store (Postgres). Closes the "no persistent backend" gap called out in
  `docs/architecture/v2.0.0-audit.md` §1. See
  `docs/architecture/adr/0007-async-storage-providers.md` for why the
  cache/checkpoint/knowledge-store providers are additive async
  capabilities rather than swapped-in sync implementations.

## Remaining

Future work (a live LLM pipeline wired through streaming/HITL/workflows,
wiring the new async knowledge store into hybrid retrieval, the Angular
client) is tracked informally; see `docs/architecture/v2.0.0-audit.md` §1
for the fuller known-gaps list.
