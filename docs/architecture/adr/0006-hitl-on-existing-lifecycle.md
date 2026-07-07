# ADR-0006: Human-in-the-loop built on the existing Agent Lifecycle, not a parallel mechanism

**Status:** Accepted
**Date:** AAI-032

## Context

While planning AAI-032 (Human-in-the-Loop), a search of the existing lifecycle state machine (`core/lifecycle/AgentState.ts`) turned up a `WaitingForUser` state — with valid transitions `Executing ⇄ WaitingForUser` already defined in `AgentLifecycle.ts`'s transition table — left over from the earlier lifecycle-formalization story that introduced `AgentState` as a whole. Nothing in the codebase used it: `LifecycleManager.mapTransitionToEvents` had no `case` for it, so entering or leaving that state published no event, ever. It was scaffolding for exactly this story, built ahead of time and left incomplete.

The alternative — building HITL as a fully separate module with its own pause/resume state, unconnected to `AgentLifecycle` — was considered and rejected: it would have meant two competing notions of "this agent is paused" existing in the codebase simultaneously (the pre-existing lifecycle state, and whatever HITL invented), with no relationship between them, directly contradicting CLAUDE.md's "Always build on: ... Agent Lifecycle ... Do not bypass these components."

## Decision

1. Complete the pre-existing, silently-dropped wiring: `LifecycleManager.mapTransitionToEvents` now handles `WaitingForUser` (publishing `InteractionRequested` on entry) and distinguishes "resumed after a human interaction" from "started fresh" on the way back to `Executing` (publishing `InteractionResolved`, not `ExecutionStarted`) — mirroring the existing `WaitingForTool` handling exactly.
2. `InteractionManager.requestApproval()`/`requestInput()` accept an optional `{ lifecycle }` and, when given one, drive the transition themselves: `Executing → WaitingForUser` on request creation, back to `Executing` on resolution — guarded by checking `getState()` first so it never fights a lifecycle already moved elsewhere by something else.
3. The actual pause experienced by calling code is `await interaction.wait()` (resolving to `UserResponse | undefined`); the resume is whoever calls `.respond()`/`.cancel()`/`.timeout()` from wherever the human actually answers (an HTTP handler, a CLI prompt, a test).

## Consequences

- HITL has no parallel pause/resume vocabulary — an agent that's waiting on a human is, unambiguously, in the same `AgentState.WaitingForUser` state any other lifecycle-aware code already knows how to check for.
- Two independent, complementary signals now fire for a lifecycle-attached interaction: `LifecycleManager`'s generic agent-state event (now covering this state) and `InteractionManager`'s own richer event (carrying the prompt/type/response). This mirrors how a span and a log entry both describe the same activity from different angles elsewhere in the framework (see ADR-0004) — not redundancy, two different consumers.
- General lesson this session reinforced twice (see also `WorkflowProvider` in ADR-0003's notes): before building a new cross-cutting capability, search for whether its foundation was already scaffolded-but-incomplete elsewhere (a reserved-but-unwired enum value, a placeholder type) rather than assuming a clean-slate build. It's worth the extra grep.
