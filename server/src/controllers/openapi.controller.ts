import type { Request, Response } from 'express';

// Hand-maintained rather than generated: the gateway's route surface is
// small and stable enough that a generator (and its dependency footprint)
// would cost more than it saves. Keep this in sync by hand when a route
// is added or changed — the same discipline PluginLoader.test.ts's
// "everything" fixture already asks of every new plugin capability.
export function buildOpenApiSpec(frameworkVersion: string): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Agentic AI Workspace — Framework HTTP Gateway',
      version: frameworkVersion,
      description:
        'REST, SSE, and WebSocket surface over the framework core (chat, agents, workflows, ' +
        'observability). WebSocket transport (GET /ws/chat, upgrade) is not representable in ' +
        'OpenAPI 3.0 and is documented here only: send {"message": string}, receive newline-' +
        'delimited JSON frames {type: "chunk"|"completed"|"error", ...}.',
    },
    paths: {
      '/health': {
        get: {
          summary: 'Liveness probe',
          responses: { '200': { description: 'Process is up.' } },
        },
      },
      '/ready': {
        get: {
          summary: 'Readiness probe',
          description: 'Checks configured optional backends (Postgres, Redis).',
          responses: {
            '200': { description: 'Ready to serve traffic.' },
            '503': { description: 'A configured backend is unreachable.' },
          },
        },
      },
      '/diagnostics': {
        get: {
          summary: 'Framework diagnostics snapshot',
          responses: { '200': { description: 'Version, plugin count, and per-subsystem diagnostics.' } },
        },
      },
      '/metrics': {
        get: {
          summary: 'Prometheus scrape endpoint',
          responses: { '200': { description: 'text/plain Prometheus exposition format.' } },
        },
      },
      '/chat': {
        post: {
          summary: 'Single-turn chat completion',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['message'],
                  properties: { message: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '200': { description: 'The assistant\'s reply.' },
            '400': { description: 'Missing or invalid "message".' },
            '500': { description: 'The LLM call failed.' },
          },
        },
      },
      '/chat/stream': {
        get: {
          summary: 'Single-turn chat completion over Server-Sent Events',
          parameters: [
            { name: 'message', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'text/event-stream of "chunk", "completed", or "error" events.',
            },
            '400': { description: 'Missing, invalid, or policy-rejected "message".' },
          },
        },
      },
      '/agent/sessions': {
        post: {
          summary: 'Spawn a live agent session',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'systemPrompt'],
                  properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    systemPrompt: { type: 'string' },
                    model: { type: 'string' },
                    maxIterations: { type: 'number' },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'The spawned session.' }, '400': { description: 'Invalid config.' } },
        },
        get: {
          summary: 'List every spawned agent session',
          responses: { '200': { description: 'Every session, in creation order.' } },
        },
      },
      '/agent/sessions/{sessionId}': {
        get: {
          summary: 'Get one session',
          parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'The session.' }, '404': { description: 'Unknown session.' } },
        },
        delete: {
          summary: 'Terminate a session',
          parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '204': { description: 'Terminated.' }, '404': { description: 'Unknown session.' } },
        },
      },
      '/agent/sessions/{sessionId}/run': {
        post: {
          summary: 'Run one message through a session',
          parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } } },
              },
            },
          },
          responses: {
            '200': { description: 'The session\'s reply.' },
            '404': { description: 'Unknown session.' },
            '409': { description: 'Session is terminated or already busy.' },
          },
        },
      },
      '/workflow/definitions': {
        get: {
          summary: 'List every registered workflow definition',
          responses: { '200': { description: 'Every definition\'s id, name, description, step count.' } },
        },
      },
      '/workflow/{definitionId}/run': {
        post: {
          summary: 'Run a registered workflow to completion',
          parameters: [{ name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { input: { type: 'object' } } },
              },
            },
          },
          responses: { '200': { description: 'The finished run.' }, '404': { description: 'Unknown definition.' } },
        },
      },
      '/workflow/runs': {
        get: {
          summary: 'List every retained workflow run',
          responses: { '200': { description: 'Every run, oldest first.' } },
        },
      },
      '/workflow/runs/{runId}': {
        get: {
          summary: 'Get one workflow run',
          parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'The run.' }, '404': { description: 'Unknown run.' } },
        },
      },
    },
  };
}

export function createOpenApiHandler(frameworkVersion: string) {
  const spec = buildOpenApiSpec(frameworkVersion);
  return (_req: Request, res: Response): void => {
    res.status(200).json(spec);
  };
}
