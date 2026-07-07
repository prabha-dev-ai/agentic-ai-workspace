# ADR-0003: Two plugin capability shapes — named catalog vs. singular swappable backend

**Status:** Accepted
**Date:** pattern present since AAI-015/AAI-022 (`VectorStoreProvider`), made explicit AAI-034 (`CheckpointStoreProvider`)

## Context

Every cross-cutting module built in AAI-026 through AAI-034 needed a way for plugins to contribute to it. By AAI-034 there were 20 plugin capabilities in `PluginCapability.ts`, and picking the wrong shape for a new one was a real risk: get it wrong and either (a) a resource that should be singular ends up ambiguously multi-valued, or (b) a resource that should support many simultaneous contributors is artificially limited to one.

Looking back across all 21, exactly two shapes were ever used, never a third:

**Shape A — named catalog.** `getXs(): XContribution[]` (plural), harvested via `PluginLoader`'s `harvestNamed` helper into `Map<string, Owned<XContribution>>` keyed by each contribution's own `.name` (or `.id`). Many plugins can each contribute one or more named `X`s; duplicate names across plugins fail installation loudly. Used for: `LogSinkProvider`, `SpanExporterProvider`, `MetricExporterProvider`, `CacheProvider`, `SecretProvider`, `StreamObserverProvider`, `InteractionObserverProvider`, `WorkflowDefinitionProvider`, plus the pre-existing `ToolProvider`, `PromptProvider`, `RetrieverProvider`, `RankingStrategyProvider`, `AgentProvider`, `WorkflowProvider`.

**Shape B — singular swappable backend.** `getX(): XContribution` (no array), harvested into `Map<string, XContribution>` keyed by *owning plugin id*, not a name field on the contribution. Exactly one contribution is ever actually wired into the corresponding manager/DI token — first-contribution-wins in `bootstrap.ts`, replacing (not joining) the built-in default. Used for: `EmbeddingProvider`, `VectorStoreProvider`, and (AAI-034) `CheckpointStoreProvider`.

## Decision

Choose the shape by asking one question before writing the capability: **does the running process want *many* of these active at once (destinations to fan out to, named resources to look up by name), or exactly *one* (a backend the whole process shares)?**

- Many-at-once → Shape A. Fan-out destinations (log sinks, exporters, observers) and named resource catalogs (caches, secret sources, workflow definitions) are Shape A even when only one plugin happens to contribute right now, because the *concept* supports many.
- Exactly-one → Shape B. A vector store, an embedding provider, a checkpoint store: the process has one durable/active instance, and a plugin contribution *replaces* the default rather than joining a list.

`CheckpointStoreProvider` (AAI-034) is the clearest recent example of applying this test deliberately: checkpointing needs one durable destination, so despite every *other* capability added in AAI-026→033 being Shape A, this one was built as Shape B — mirroring `VectorStoreProvider`, not the six named-catalog capabilities that came immediately before it in the same session.

## Consequences

- `PluginLoader.ts` carries two harvesting idioms side by side (the `harvestNamed`-based catalogs, and the plugin-id-keyed unnamed maps) — both are simple, neither needed to grow a third variant across 20 capabilities.
- Shape B capabilities need an explicit "first contribution wins" rule at the bootstrap wiring site (`const [contributed] = pluginLoader.getXs(); if (contributed) manager.useX(contributed);`) since, unlike Shape A, there's no natural way to use more than one.
- Getting the shape choice right up front avoids a breaking change later: `PluginCapability.ts`'s pre-existing `WorkflowProvider`/`WorkflowContribution` (Shape A, numeric step ids, no execution behavior) was left untouched in AAI-033 specifically because retrofitting it to the richer executable model would have meant changing a shipped, tested type — instead a new, separately-named Shape-A capability (`WorkflowDefinitionProvider`) was added alongside it. See the AAI-033 story notes for the full reasoning.
