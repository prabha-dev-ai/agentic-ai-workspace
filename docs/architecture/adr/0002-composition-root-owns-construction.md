# ADR-0002: The composition root owns all singleton construction

**Status:** Accepted
**Date:** established AAI-014A/B, held through AAI-034; re-verified AAI-035

## Context

`core/bootstrap.ts` is the framework's single composition root: the one place the full object graph — DI container, plugin loader, and (as of AAI-026→034) nine cross-cutting service singletons — is wired together. As each new cross-cutting module (observability, tracing, metrics, caching, security, streaming, interaction, workflow, checkpoint) was added, the same question came up every time: does this module construct its own dependencies, or does bootstrap hand them in?

The risk of getting this wrong compounds specifically around the OpenAI client: if any module were allowed to construct its own `OpenAI` instance, the framework would end up with multiple HTTP connection pools, no single point to swap credentials or the base URL, and no way to fake the client in tests without reaching into module internals.

## Decision

Two rules, both mechanically enforced by `core/architecture.test.ts`, not just convention:

1. `new OpenAI(...)` may appear exactly once in the entire source tree, in `core/bootstrap.ts`. Every other module receives the client as a constructor/factory parameter and types it with `import type`.
2. Every DI-registered service is a **singleton, lazily constructed on first resolution** via `services.registerSingleton(TOKENS.x, (container) => ...)`. No registered service constructs another registered service directly — it asks the container for it.

Cross-cutting modules that need to exist *before* plugin installation (so they can observe install-time events or be ready to receive plugin contributions immediately) are constructed directly in `bootstrap.ts` ahead of the plugin-install loop, then registered into the `ServiceCollection` afterward — construction and registration are two separate steps, not one.

## Consequences

- A container-wide `container.get(TOKENS.openaiClient)` always returns the same instance; tests can build a container and never touch the network unless they explicitly resolve that token.
- Adding a new cross-cutting module never requires touching any *other* module's constructor — bootstrap is the only file that changes to wire a new one in, keeping module-to-module coupling at zero (confirmed: none of the nine cross-cutting modules import each other).
- The rule is self-enforcing: a violation fails `npm test` via `architecture.test.ts`'s raw-text scan for `new OpenAI(` and non-type `from 'openai'` imports, not a lint rule someone can silence with a comment.
- One caveat surfaced during AAI-030 (Security): a *comment* containing the literal substring `process.env` (explaining why a file *doesn't* read it) trips the equivalent env-ownership check, because the scan is textual, not semantic. Comments referencing these guarded APIs must paraphrase instead of quoting them literally.
