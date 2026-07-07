# ADR-0001: Const-object unions instead of TypeScript enums

**Status:** Accepted
**Date:** first applied AAI-014 (container `Lifetime`), followed consistently through AAI-034

## Context

The framework runs source `.ts` files directly under Node's native TypeScript type-stripping (`node --experimental-strip-types`), not through a bundler or `ts-node`. Type stripping erases *type-only* constructs — interfaces, `type` aliases, `import type` — but `enum` is not type-only: it compiles to a runtime object (and, for numeric enums, a reverse mapping). Node's stripper cannot emit that object from a bare `enum` declaration, so `enum` cannot be used anywhere in this codebase without a build step standing between source and execution — which the project deliberately does not have for development/test.

Every module that needed a closed set of named string values (log levels, agent states, span status, stream state, interaction status, workflow status, metric type, event type, plugin capability — at last count, 9 such unions across `core/`) faced this same constraint.

## Decision

Use a `const` object with `as const`, plus a derived type alias, everywhere a TypeScript enum would otherwise be reached for:

```ts
export const LogLevel = {
  Debug: 'debug',
  Info: 'info',
  Warn: 'warn',
  Error: 'error',
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];
```

The type and the value share a name deliberately (matching how an `enum` reads at call sites: `LogLevel.Debug` is both the value and, via `typeof`, referenceable as a type). Every one of the 9 unions in `core/` follows this exact shape.

## Consequences

- Works identically whether the code runs via native type-stripping, `tsc`, or any other TS-erasing toolchain — no enum-specific runtime support required.
- String values only (no numeric enum auto-increment) — acceptable since every union in this codebase is a small, explicitly-named set where the string *is* the meaningful identity (a log line, an event type on the wire) — auto-incrementing numbers would need a separate label anyway.
- Slightly more boilerplate per union (object + type alias) than a single `enum` keyword — accepted as the cost of staying build-step-free.
- Discovered and applied consistently enough that it needed no further discussion after AAI-014 — every subsequent story's `XState.ts`/`XType.ts`/`XStatus.ts` file follows the same two-line pattern without deviation.
