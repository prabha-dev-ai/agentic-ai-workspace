# ADR-0004: One correlation id threaded through logs, traces, and every cross-cutting event

**Status:** Accepted
**Date:** established AAI-026/027, extended through AAI-034

## Context

`core/events/EventBus.ts` stamps every published event with a `correlationId` (defaulting to the event's own `eventId` if the publisher doesn't supply one). Once `ObservabilityService.observeEventBus()` (AAI-026) started turning every event into a structured log entry tagged with that same `correlationId`, and `TraceManager.observeEventBus()` (AAI-027) started reusing it directly as a trace id, a pattern emerged: rather than inventing a separate identifier scheme for each new cross-cutting concern, reuse whatever id the framework's own event bus already assigned.

## Decision

Every cross-cutting module that bridges into the event bus publishes with `correlationId` set to *its own subject's id* — not a fresh, unrelated identifier:

- `TraceManager.observeEventBus()` uses `envelope.correlationId` as the `traceId` directly (and, cleverly, as a *virtual parent span id* too — see the module's own comment — so every event sharing one correlation id lands as siblings under one trace instead of each falsely claiming to be root).
- `StreamManager.connectEventBus()` publishes stream milestones with `correlationId: streamId`.
- `InteractionManager.connectEventBus()` publishes with `correlationId: interactionId`.
- `WorkflowRuntime.connectEventBus()` publishes with `correlationId: runId`.
- `CheckpointManager.connectEventBus()` publishes with `correlationId: subjectId` (the caller's own key — an agent id, a workflow run id).

The result: given any one of these ids, every log entry, span, and cross-cutting event touching that same unit of work is discoverable through the *same* field, without a lookup table mapping one id scheme to another.

## Consequences

- New cross-cutting modules get correlation "for free" by following the convention — no new design decision required, no separate correlation-id-generation logic to write or test.
- The convention only covers modules that *choose* to bridge onto the event bus. Metrics, Caching, and Security deliberately don't (see ADR-0005's sibling reasoning in the module comments): a metric has no "this happened" moment, a cache has no natural broadcast point, and Security's `getSecret()` is a synchronous request/response with no cross-cutting timeline to correlate. Their diagnostics are self-contained instead.
- A subtlety worth remembering: because `TraceManager` reuses the correlation id as *both* `traceId` and a virtual parent span id, a trace built purely from bridged events (rather than explicit `startSpan`/`end` calls) never gets a "real" root span — every span in it has a defined `parentSpanId` pointing at the (non-existent) virtual root. This is intentional, not a bug, but it means `Trace.rootSpanId` can legitimately stay `undefined` for event-bus-only traces.
