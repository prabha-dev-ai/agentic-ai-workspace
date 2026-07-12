# ADR-0007: Persistent storage as additive async capabilities, not synchronous swaps

**Status:** Accepted
**Date:** AAI-036

## Context

AAI-036 asked for pluggable persistent providers behind four existing in-memory implementations: `VectorStore`, `Cache`, `CheckpointStore`, and `KnowledgeStore` — replacing the backend while "preserving all existing abstractions" and "no breaking public APIs" (CLAUDE.md's Engineering Rules).

Auditing the four interfaces before writing any provider surfaced a hard split:

- `VectorStore` (`core/vectorstore/VectorStore.ts`) is already fully `Promise`-based on every method. A pgvector-backed implementation drops in behind the existing interface with zero changes to it or any caller.
- `Cache`, `CheckpointStore`, and `KnowledgeStore` are all fully **synchronous** — `get()`, `save()`, `getLatest()`, `add()`, etc. return values directly, no `Promise`. Every existing caller (`CacheRegistry.getOrCreate`, `CheckpointManager.checkpoint()`/`recover()`, `retriever.service.ts`) calls them without awaiting.

Node.js has no synchronous Postgres or Redis client — real network I/O to either backend is unavoidably async. Two options were weighed (both discussed with the requester before implementation started):

1. **Write-behind hybrid**: keep the sync interfaces and every call site untouched; the Postgres/Redis-backed implementation holds an in-memory mirror for instant sync reads/writes, hydrates that mirror from the real backend once via an explicit async `connect()` at bootstrap, and persists writes to the backend in the background (fire-and-forget, errors logged). Zero breaking changes, but a process crash in the narrow window before a background flush completes can silently lose the single most-recent write — for a checkpoint store, whose entire purpose is crash recovery, that caveat undermines the feature.
2. **Additive async capabilities**: leave every existing sync interface, class, and call site completely untouched; add new, separate async sibling interfaces (`AsyncCache`, `AsyncCheckpointStore`, `AsyncKnowledgeStore`) plus new plugin capabilities, and extend `CacheRegistry`/`CheckpointManager` with new opt-in async methods (`registerAsync`/`getAsync`, `useAsyncStore`/`checkpointAsync`/`recoverAsync`). No eventual-consistency risk, no event-loop blocking — but existing sync callers gain nothing until/unless they're migrated to the new async methods, and the codebase now carries two parallel vocabularies for caching and checkpointing.

## Decision

Chosen: **additive async capabilities** (option 2), selected by the requester after the trade-off was presented explicitly.

- `VectorStore` needed no such choice — `PostgresVectorStore` is a direct, interface-preserving swap. `TOKENS.vectorStore` in `core/bootstrap.ts` conditionally binds to it instead of `InMemoryVectorStore` when `DATABASE_URL` is set; nothing downstream (the vector-store plugin, `hybridRetriever`) can tell the difference.
- `Cache`/`CheckpointStore`/`KnowledgeStore` and their in-memory implementations are **completely unchanged** — not one line touched.
- Three new interfaces (`core/caching/AsyncCache.ts`, `core/checkpoint/AsyncCheckpointStore.ts`, `knowledge/async-knowledge-store.ts`) and three new plugin capabilities (`AsyncCacheProvider`, `AsyncCheckpointStoreProvider`, `AsyncKnowledgeStoreProvider` — the third is genuinely new; `KnowledgeStore` was never exposed as a plugin capability at all before this story) carry the Postgres/Redis-backed implementations.
- `CacheRegistry` gained a second, parallel catalog (`registerAsync`/`getAsync`/`hasAsync`) rather than trying to unify sync and async caches under one map. `CheckpointManager` gained a second, parallel backend slot (`useAsyncStore`/`getAsyncStore`) alongside the untouched sync `useStore`/`getStore`, with `checkpointAsync()`/`recoverAsync()` as the async twins of `checkpoint()`/`recover()` — both publish the same event types onto the shared event bus.
- `AsyncCacheProvider` uses the *named-catalog* capability shape (ADR-0003) — `PluginLoader` needs `.name` at install-time harvest for dedup, so `RedisCache` is handed to its plugin factory pre-built, not behind the lazy accessor `VectorStoreProvider`/`EmbeddingProvider` use (those need laziness only because they're the *singular-swappable-backend* shape with a genuine circular dependency on the not-yet-built container; `RedisCache` has no such dependency — it only needs a `RedisClient`, which bootstrap already holds before any plugin installs).

## Consequences

- No existing test, call site, or public type signature changed for `Cache`, `CheckpointStore`, or `KnowledgeStore` — verified by the full pre-existing test suite passing unmodified.
- Consumers that want durability must explicitly opt in at each call site (`checkpointAsync` instead of `checkpoint`, `caching.getAsync('redis')` instead of `caching.getOrCreate(...)`). `retriever.service.ts`/`hybrid-retriever.ts` were deliberately **not** rewired to consume `AsyncKnowledgeStore` in this story — the same scope boundary the v2.0.0 audit drew around streaming/HITL/workflow infrastructure shipping ahead of the live chat pipeline consuming it (`docs/architecture/v2.0.0-audit.md` §1). Wiring an async knowledge source into retrieval is tracked as future work, not a defect of this story.
- The framework now has two documented vocabularies for "get a cache" and "checkpoint something" — sync (in-memory, always available) and async (network-backed, opt-in). This is a real, accepted cost: the alternative (write-behind hybrid) buys API uniformity at the price of a silent data-loss window on the one feature (checkpointing) where that window matters most.
- `PostgresVectorStore`/`PostgresCheckpointStore`/`PostgresKnowledgeStore` all require an explicit async `connect()` call before use (table/extension creation, row-count priming) — constructors can't be async, so this mirrors the pattern every other cross-cutting module in `core/bootstrap.ts` already uses (construct synchronously, wire asynchronously, before `bootstrap()` returns).
