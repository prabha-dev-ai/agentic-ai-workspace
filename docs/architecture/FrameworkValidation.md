# Framework Validation & Dependency Audit (AAI-014C)

**Date:** 2026-07-05
**Scope:** Full architectural audit after AAI-014A/B (DI container, bootstrap, DI standardization).
**Verified by:** 25 automated tests (14 container, 5 bootstrap, 6 architectural fitness tests) — all passing.

---

## 1. Dependency Graph

Arrows point from consumer to dependency. `(t)` = type-only edge.

```
server.ts ──► app.ts ──► core/bootstrap ──► core/container (ServiceCollection ─► Container)
   │             │             │
   │ env         │             ├──► config/env
   │             │             ├──► openai  (the ONLY value import / construction site)
   │             │             ├──► services/llm.service ────────┐
   │             │             ├──► planner/planner.service      │
   │             │             ├──► executor/executor.service    │
   │             │             ├──► agents/agent.runtime (factory)│
   │             │             └──► knowledge/knowledge-store    │
   │             │                                               │
   │             └──► routes/chat.routes ──► controllers/chat.controller ──► llm.service (t)
   │
   ├─ llm.service ──────► agents/agent-loop ──► tools/tool-registry ──► tools/time.tool
   │        │                                   prompts/{system,json-output}
   │        └───────────► types/ai-response (t)
   ├─ planner.service ──► prompts/planner, planner.types (t)
   ├─ executor.service ─► agents/agent-loop, prompts/executor, planner.types (t), executor.types (t)
   └─ agents/agent.runtime ──► agents/agent-loop
                               agents/agent.factory ──► config/env
                               memory/{conversation-memory, context-manager}
                               knowledge/retriever.service
                               prompts/rag
```

**Circular dependencies: none at runtime.** `ServiceDescriptor ↔ Container` cross-reference is
type-only (erased at compile time). The container additionally detects *service-level* cycles at
resolution time and reports them as a readable chain.

## 2. Layer Diagram

```
L4  HTTP            app.ts, routes/, controllers/          Express lives ONLY here (tested)
L3  Composition     core/bootstrap.ts, core/tokens.ts      only place that constructs services (tested)
L2  Domain          services/, planner/, executor/,        never imports L3/L4 (tested)
                    agents/, memory/, knowledge/, tools/
L1  Infrastructure  core/container/                        imports nothing outside itself (tested)
L0  Leaf data       config/env.ts, prompts/, types/        no dependencies on other layers
```

Every layer rule marked "(tested)" is enforced by `src/core/architecture.test.ts` — violations
fail `npm test`, not code review.

## 3. Service Lifetime Table

| Token                  | Lifetime  | State       | Rationale |
|------------------------|-----------|-------------|-----------|
| `openai-client`        | Singleton | stateless   | HTTP wrapper; per-request creation wastes connections. Created lazily in bootstrap; sole construction site (tested). |
| `llm-service`          | Singleton | stateless   | Pure orchestration around the injected client. |
| `planner-service`      | Singleton | stateless   | Same. |
| `executor-service`     | Singleton | stateless   | Same; step state is local to each `executePlan` call. |
| `agent-runtime-factory`| Singleton | stateless   | Mints runtimes; holds only the client binding. |
| `knowledge-store`      | Singleton | **stateful**| Shared knowledge base is the point; single instance intended. |
| AgentRuntime (unregistered) | per-conversation | stateful (memory) | Deliberately NOT container-managed: runtimes are session state created via the factory, one per conversation. |
| ConversationMemory (unregistered) | per-runtime | stateful | Created inside its runtime; sharing it would leak conversations across sessions. |

Transient lifetime is implemented and tested in the container but currently unused — correct,
since no registered service is stateful-per-use. First real candidates: per-request scopes.

## 4. Audit Findings

### Verified clean
- **Client consolidation:** `new OpenAI(` appears exactly once (bootstrap); every other module
  uses `import type` (both tested).
- **Injection consistency:** all five registered services receive dependencies via factory
  parameters; no service constructs another service. The two remaining direct constructions
  (`createConversationMemory` inside runtimes, tool functions inside the registry) are
  intentional per-instance/leaf state, not shared services.
- **Configuration:** `process.env` is read only by `config/env.ts` (tested); dotenv loads in
  exactly one place.
- **HTTP isolation:** domain code cannot reach Express, controllers, routes, or bootstrap (tested).

### Remaining technical debt (ranked)
1. **Tool registry is hardwired** — `agent-loop.ts` imports `toolDefinitions`/`executeTool`
   directly, so every agent gets every tool. Blocks per-agent tool subsets and is the main
   prerequisite for plugin architecture. *Fix: make tools a `runAgentLoop` parameter, registry
   becomes an injectable service.*
2. **`env` imported directly by domain code** — `llm.service`, `planner.service`,
   `executor.service`, `agent.factory` read `env.llm.model` at call time. Works, but model
   selection can't vary per container. *Fix: an `llmConfig` token injected like the client.*
3. **Duplicated JSON fence-stripping** — `llm.service` and `planner.service` carry identical
   `parseX` fence logic. *Fix: `utils/json.ts` (noted since AAI-008A).*
4. **Naming inconsistency** — `core/` uses PascalCase files (per AAI-014A spec), the rest
   kebab-case; `types/ai-response.ts` is centralized while other types are colocated
   (`planner/planner.types.ts`). Cosmetic; decide one rule before the codebase grows.
5. **Services untestable without an API key** — resolving `openai-client` requires
   `LLM_API_KEY`; bootstrap tests fail in a keyless CI. *Fix: allow client-registration
   override at bootstrap, or a fake-client bootstrap variant for tests.*

## 5. Recommendations

1. Do debt #1 (injectable tools) **as part of AAI-015** — plugins are largely "tools that
   register themselves," so the fix is the story's natural first step.
2. Take debt #2 and #3 as a small cleanup story; both are mechanical.
3. Adopt a naming decision (#4) now, enforce it later with a lint rule rather than a rewrite.
4. Keep the architecture tests growing: each new layer rule added in a story should land with
   its fitness test in the same commit.

## 6. Readiness for Plugin Architecture (AAI-015)

**Ready, with one prerequisite.** What plugins need and what exists:

| Plugin need                            | Status |
|----------------------------------------|--------|
| A place to register capabilities       | ✅ ServiceCollection/Container with typed tokens |
| Deterministic startup wiring           | ✅ bootstrap composition root |
| Lifetime management                    | ✅ singleton/transient, lazy creation |
| Duplicate/collision protection         | ✅ duplicate registration throws |
| Isolation between registrations        | ✅ per-build containers (tested) |
| **Dynamic tool contribution**          | ⚠️ blocked by debt #1 — the tool registry is a hardcoded module constant |
| Discovery/loading of plugin modules    | ❌ does not exist yet (this IS AAI-015) |

**Architecture score: 8/10.** The two withheld points: hardwired tool registry (the one real
inversion-of-control gap) and config-by-import in domain services. Neither is structural damage;
both have clear, local fixes.
