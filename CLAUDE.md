# Agentic AI Workspace

## Goal

Build a production-quality Agentic AI Framework to understand how modern AI frameworks are built internally.

## Workflow

For every story:

1. Implement the story.
2. Run:
   - Typecheck (`tsc --noEmit`)
   - Build
   - Full test suite
3. Verify everything passes.
4. Provide:
   - Architecture Summary
   - Design Decisions
   - Trade-offs
   - Diagnostics
   - Test Summary
5. Stop and wait for commit approval.
6. One story = one Git commit.

## Engineering Rules

- Extend the existing architecture.
- Never duplicate existing functionality.
- Reuse existing services.
- Maintain backward compatibility.
- Prefer composition over duplication.
- Add unit tests for new functionality.
- Keep public APIs stable.
- Keep implementations testable.

## Core Architecture

Always build on:

- Dependency Injection
- Plugin Platform
- Event Bus
- Agent Lifecycle
- Agent Registry
- Message Bus
- Delegation
- Supervisor
- Embedding Service
- Vector Store
- Observability (structured logging)
- Tracing
- Metrics
- Caching
- Security (secrets, redaction, input validation)
- Streaming
- Human-in-the-Loop (Interaction Manager)
- Workflow Engine
- Checkpoint & Recovery

Do not bypass these components.

## Coding Standards

- Small focused classes.
- Clear interfaces.
- Constructor injection.
- Typed errors.
- No hidden dependencies.
- Prefer dependency injection over direct construction.

## Technology Stack

- Backend: Node.js, Express, TypeScript (strict mode, ES Modules).
- AI: OpenRouter via the OpenAI SDK.
- Frontend: Angular.
- Database: MongoDB (later).

## Enforced Invariants

These rules are verified by `server/src/core/architecture.test.ts` — violating them fails the build:

- `new OpenAI(...)` appears only in `core/bootstrap.ts` (the composition root owns the client).
- `process.env` is read only by `config/env.ts`. Never hardcode API keys.
- Express stays in the HTTP layer (`app.ts`, `controllers/`, `routes/`).
- Domain modules never import controllers, routes, or bootstrap.
- The DI container imports nothing outside `core/container/`.