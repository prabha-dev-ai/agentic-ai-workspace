# 🚀 Agentic AI Workspace

> Learn Agentic AI by building a production-style Agentic AI Framework from scratch in TypeScript.

**Current Version:** `v2.0.0`

---

# Overview

**Agentic AI Workspace** is a hands-on learning project: instead of learning agentic AI through tutorials or a pre-built framework, this repo builds one — one core concept at a time, each landing as its own story (`AAI-0XX`), each verified by typecheck + build + a full automated test suite before it's considered done.

v2.0.0 is the **Framework Release** milestone: a multi-agent runtime with a dependency-injected core, a plugin platform, and nine production-grade cross-cutting capabilities (observability, tracing, metrics, caching, security, streaming, human-in-the-loop, workflow orchestration, and checkpoint & recovery) built on top of it.

---

# Architecture at a glance

Everything lives under `server/src/core/`, wired together by one composition root (`core/bootstrap.ts`) and resolved through a typed dependency-injection container. Nothing outside `core/bootstrap.ts` constructs a shared service directly.

**Runtime & orchestration**
- `container/` — `ServiceCollection`/`Container`: typed tokens, singleton/transient lifetimes, cycle detection.
- `events/` — `EventBus`: ordered, correlated, handler-isolated pub/sub. Every cross-cutting module below can bridge onto it.
- `lifecycle/` — `AgentLifecycle`/`LifecycleManager`: the agent execution state machine (`Created → ... → Executing → Completed/Failed/Cancelled`, plus `WaitingForTool`/`WaitingForUser`), with lifecycle transitions publishing framework events.
- `agents/`, `communication/`, `delegation/`, `supervisor/` — agent registry, inter-agent messaging, task delegation, and the supervisor agent.
- `plugins/` — plugin discovery, install/uninstall, and 20 typed capability kinds (tools, prompts, retrievers, log sinks, span/metric exporters, caches, secret sources, stream/interaction observers, workflow definitions, and more) that plugins declare and the framework harvests.
- `embeddings/`, `vectorstore/` — embedding provider abstraction + in-memory vector store, swappable via the plugin platform.

**Production capabilities (AAI-026 → AAI-034)**
- `observability/` — structured, leveled logging with pluggable sinks.
- `tracing/` — distributed tracing: spans, parent/child relationships, automatic timing.
- `metrics/` — counters, gauges, histograms, pluggable exporters.
- `caching/` — TTL + LRU-eviction in-memory cache, pluggable backends.
- `security/` — secret abstraction with redaction, API key provider, input validation, security policy.
- `streaming/` — chunked streaming responses with lifecycle events.
- `interaction/` — human-in-the-loop: approval/input requests that pause and resume an agent's lifecycle.
- `workflow/` — a sequential + conditionally-branching workflow engine.
- `checkpoint/` — save/recover state snapshots, swappable storage backend.

Every one of the nine above follows the same shape: a typed model, an in-memory default implementation, a manager/registry that owns diagnostics and (where it makes sense) an event bus bridge, and a plugin capability so a third-party plugin can extend or replace the default. See [`docs/architecture/adr/`](docs/architecture/adr/) for the specific decisions behind that shape, and [`docs/architecture/v2.0.0-audit.md`](docs/architecture/v2.0.0-audit.md) for the full dependency graph, layering rules, and audit findings.

An automated architectural fitness suite (`server/src/core/architecture.test.ts`) enforces the framework's own rules — a single OpenAI client construction site, `process.env` confined to `config/env.ts`, Express confined to the HTTP layer, no upward imports from domain code — as part of `npm test`, not just code review.

---

# Technology Stack

## Backend

- Node.js (native TypeScript execution — no build step needed for `npm run dev`/`npm test`)
- Express
- TypeScript (strict mode, ES Modules)

## AI

- OpenRouter (or any OpenAI-compatible endpoint) via the OpenAI SDK

## Frontend

- Angular *(not started — see [Project Structure](#project-structure))*

## Database

- MongoDB *(not yet used — every store shipped so far is in-memory with a swappable backend)*

---

# Getting Started

```bash
git clone <this-repo>
cd agentic-ai-workspace/server
npm install
cp .env.example .env   # then fill in LLM_API_KEY (see below)
npm run build           # tsc — compiles src/ to dist/
npm test                 # full automated test suite (500+ tests)
npm run dev               # starts the API with file-watching
```

## Environment variables

Copy `server/.env.example` to `server/.env` and fill in the values your setup needs. Every variable the framework reads is defined in **exactly one place** — `server/src/config/env.ts` — and documented in that example file. Only `LLM_API_KEY` is required to actually call a model; everything else (`server/.env`, `npm test`, `npm run build`) works without it, since the OpenAI client is constructed lazily and only resolved when something actually needs it.

## Verifying your setup

```bash
cd server
npx tsc --noEmit   # typecheck only, no output files
npm run build        # full compile
npm test              # should report "pass: <N>, fail: 0"
```

If all three are clean, your environment matches what every story in this repo was built and verified against.

## Try it

`server/src/examples/quickstart.ts` walks through bootstrapping the framework and exercising several of its capabilities (plugin diagnostics, tracing, metrics, the workflow engine, checkpoint & recovery) without needing an LLM API key:

```bash
cd server
node --disable-warning=ExperimentalWarning src/examples/quickstart.ts
```

---

# Project Structure

```text
agentic-ai-workspace/
├── server/              # the framework — everything described above lives here
│   ├── src/
│   │   ├── core/         # DI, events, lifecycle, plugins, and the 9 production capabilities
│   │   ├── agents/        # agent runtime, agent loop, agent factory
│   │   ├── services/       # LLM service
│   │   ├── planner/         # planning
│   │   ├── executor/         # plan execution
│   │   ├── knowledge/         # RAG: retrieval, ranking
│   │   ├── memory/             # conversation memory
│   │   ├── plugins/             # built-in plugins (e.g. the time tool)
│   │   ├── examples/             # runnable examples (see "Try it" above)
│   │   ├── controllers/, routes/ # HTTP layer
│   │   └── config/               # env.ts — the ONLY place process.env is read
│   └── package.json
├── docs/
│   ├── ROADMAP.md
│   └── architecture/
│       ├── v2.0.0-audit.md   # release + architecture validation audit
│       ├── FrameworkValidation.md  # earlier (AAI-014C) audit, kept for history
│       └── adr/                     # architecture decision records
├── client/, agents/, shared/, tests/, tools/, scripts/, prompts/, memory/
│                          # reserved for future work — currently empty scaffolding
├── CLAUDE.md              # engineering rules & architecture this repo is built against
├── CHANGELOG.md
└── README.md
```

---

# Learning Goals

Concepts implemented from scratch across this project: LLM fundamentals, prompt engineering, structured output, function/tool calling, the agent loop, memory management, planning, retrieval-augmented generation (RAG), multi-agent systems (registry, messaging, delegation, supervision), a plugin platform, dependency injection, and nine production-grade cross-cutting capabilities (observability, tracing, metrics, caching, security, streaming, human-in-the-loop, workflow orchestration, checkpoint & recovery).

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the full, story-by-story history, and [`CHANGELOG.md`](CHANGELOG.md) for what's new in each release.

---

# Why This Project?

This project exists to gain a deep understanding of agentic AI by implementing every major concept from scratch, rather than starting from an existing framework. The knowledge gained here feeds into **ProjectPilotAI** and other enterprise AI applications.

---

# License

This project is licensed under the MIT License.
