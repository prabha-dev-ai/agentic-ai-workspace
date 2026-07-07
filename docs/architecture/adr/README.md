# Architecture Decision Records

Short records of decisions made while building the framework, written after the fact (AAI-035 release audit) from the patterns actually applied across AAI-014 through AAI-034 — not speculative. Each one documents a decision that repeated at least three times across independently-built modules, which is what makes it a decision worth writing down rather than a one-off implementation detail.

| ADR | Title |
|-----|-------|
| [0001](0001-const-object-unions.md) | Const-object unions instead of TypeScript enums |
| [0002](0002-composition-root-owns-construction.md) | The composition root owns all singleton construction |
| [0003](0003-two-plugin-capability-shapes.md) | Two plugin capability shapes: named catalog vs. singular swappable backend |
| [0004](0004-correlation-id-propagation.md) | One correlation id threaded through logs, traces, and every cross-cutting event |
| [0005](0005-failure-as-state.md) | Failure as state, not exceptions, at cross-cutting boundaries |
| [0006](0006-hitl-on-existing-lifecycle.md) | Human-in-the-loop built on the existing Agent Lifecycle, not a parallel mechanism |
