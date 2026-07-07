# ADR-0005: Failure as state, not exceptions, at cross-cutting boundaries

**Status:** Accepted
**Date:** established AAI-027 (`SpanStatus`), applied consistently through AAI-034 (`RecoveryResult`)

## Context

Every cross-cutting module built in AAI-027 through AAI-034 represents a unit of work that can fail *as a normal, expected outcome* — a span records an error, a stream fails mid-transmission, a workflow step throws, a checkpoint recovery finds nothing. The question that came up repeatedly: should the module's primary API throw when the underlying work fails, or return a value describing what happened?

Two different failure categories exist in every one of these modules, and conflating them was the risk:

1. **Misuse** — calling code did something the API contract forbids (an empty name, a duplicate registration, mutating an already-terminal object, running an undefined workflow id). This is a programming error, not a runtime outcome.
2. **Expected runtime outcome** — the operation ran correctly but the *result* is failure, absence, or rejection (a step threw, a stream's producer failed, an interaction was cancelled, no checkpoint exists yet for a subject).

## Decision

Category 1 always throws a typed error synchronously, at the call site of the misuse — each module defines its own (`TraceError`, `StreamError`, `WorkflowError`, `CheckpointError`, ...). Category 2 never throws — it's represented as a terminal state or a typed result value the caller inspects:

- `Span.end(status, error)` — status is data (`SpanStatus.Error`), not a thrown exception; ending an already-ended span (category 1) *does* throw.
- `Stream.fail(error)` — same split: failing a stream is a state transition; pushing to an already-terminal stream throws.
- `WorkflowRuntime.run()` **never rejects** for a step throwing — it catches the step's exception and returns a `WorkflowRun` with `status: 'failed'` and `error` set. It *does* throw synchronously for an unregistered `definitionId` (category 1, misuse).
- `CheckpointManager.recover()` **never throws** for "no checkpoint found" — it returns `RecoveryResult` (`{ recovered: false, subjectId, reason }`). Saving with an empty `subjectId` (category 1) throws.
- `Interaction.respond()/cancel()/timeout()` resolve the interaction's `wait()` promise with data (`UserResponse | undefined`), never reject it; calling any of the three on an already-resolved interaction throws.

## Consequences

- Callers that want to `await` a batch of cross-cutting operations without one failure aborting the batch don't need `Promise.allSettled` gymnastics — `run()`/`recover()`/etc. already settle successfully every time, with the outcome in the return value.
- Every "outcome" type in the framework is a discriminated union rather than a shape with optional fields standing in for success/failure (`RecoveryResult`, `WorkflowEvent`, `StreamEvent`, `InteractionEvent`, `MetricSnapshot`) — switching on the discriminant is exhaustive and type-checked, so a consumer can't accidentally read a field that doesn't exist for that outcome.
- The trade-off: callers must remember to check the result's status/discriminant rather than relying on a `try/catch` to notice failure. This is deliberate — a `catch` block silently swallowing an *expected* outcome (an interaction being cancelled, a workflow step failing) would be the wrong default; making the caller look at the result forces that outcome to be handled, not ignored.
