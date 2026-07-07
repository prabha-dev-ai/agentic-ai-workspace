# Changelog

All notable changes to this project are documented here, grouped by release. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions correspond to the framework's `AAI-0XX` story numbering rather than semver-per-commit.

## [2.0.0] — 2026-07-08 — Framework Release (AAI-035)

The **Framework Release** milestone: a multi-agent runtime with a dependency-injected core, a plugin platform, retrieval, and nine production-grade cross-cutting capabilities. No new framework functionality in this release itself — it's documentation, architecture validation, and release packaging for everything added since v1.0.0.

### Added

- **Retrieval** — hybrid (keyword + vector) retrieval (AAI-024); pluggable knowledge ranking strategies (AAI-025).
- **Observability** — structured, leveled logging with pluggable sinks and an event bus bridge (AAI-026).
- **Tracing** — distributed tracing: spans, parent/child relationships, automatic timing, pluggable exporters (AAI-027).
- **Metrics** — counters, gauges, histograms, pluggable exporters (AAI-028).
- **Caching** — TTL + LRU-eviction in-memory cache, pluggable backends (AAI-029).
- **Security** — a `Secret` abstraction with automatic redaction, an API key provider, input validation, and a configurable security policy (AAI-030).
- **Streaming** — chunked streaming responses with a full lifecycle (pending/active/completed/error/cancelled) and an event bus bridge (AAI-031).
- **Human-in-the-loop** — approval/input interactions that pause and resume an agent's lifecycle, built directly on the pre-existing `AgentState.WaitingForUser` state (AAI-032).
- **Workflow engine** — sequential execution with conditional branching, an event bus bridge covering every run/step milestone (AAI-033).
- **Checkpoint & recovery** — save/recover state snapshots per subject, a swappable storage backend, an event bus bridge (AAI-034).
- **Plugin platform growth** — 9 new plugin capabilities backing the above (`LogSinkProvider`, `SpanExporterProvider`, `MetricExporterProvider`, `CacheProvider`, `SecretProvider`, `StreamObserverProvider`, `InteractionObserverProvider`, `WorkflowDefinitionProvider`, `CheckpointStoreProvider`), bringing the total to 21.
- **Release documentation (AAI-035)** — `docs/architecture/v2.0.0-audit.md` (release audit + re-validated architecture), `docs/architecture/adr/` (6 architecture decision records), `server/.env.example`, `server/src/examples/quickstart.ts`, this changelog.

### Changed

- `docs/ROADMAP.md` — AAI-024 through AAI-035 marked complete.
- `CLAUDE.md` — the Core Architecture list now includes the nine cross-cutting modules above; future stories must build on them the same way they already build on DI, the plugin platform, and the event bus.
- `README.md` — rewritten to describe the current architecture, setup, and project structure instead of the original Sprint-0 placeholder content.
- `.gitignore` — added a `!.env.example` exception so the new setup-verification template is actually tracked.
- `server/src/core/lifecycle/LifecycleManager.ts` — `mapTransitionToEvents` now handles `AgentState.WaitingForUser` (previously silently dropped), publishing `InteractionRequested`/`InteractionResolved`.

### Fixed

- A real bug in `WorkflowRuntime.run()`'s sequential-fallthrough logic, caught while writing AAI-033's tests: a step reached via a conditional-branch jump could then fall through to the wrong step, because fallthrough was tracked with an independently-incrementing counter instead of the current step's actual position. Fixed before the AAI-033 commit landed.

### Verified

- 504 tests passing across 153 suites (`npm test`), `tsc --noEmit` clean, `npm run build` clean.
- `server/src/core/architecture.test.ts`'s six fitness functions (single OpenAI client construction site, `openai` value-import confinement, `process.env` confinement, container purity, Express confinement, domain-layer upward-import ban) re-verified against the full v2.0.0 tree.
- `server/src/examples/quickstart.ts` runs end-to-end without an `LLM_API_KEY`.

---

## [1.0.0] — Agent Framework (through AAI-013)

The original agent framework: LLM fundamentals, prompt engineering, structured output, function/tool calling, the agent loop, memory, planning, RAG, multi-agent systems (registry, messaging, delegation, supervision), and the plugin platform foundation (AAI-014/AAI-015 era). Tagged on `feature/llm-foundation`.
