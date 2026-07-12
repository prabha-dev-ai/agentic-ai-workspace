import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { WorkflowRuntime } from '../core/workflow/index.ts';
import { ObservabilityService } from '../core/observability/index.ts';
import { SecurityService } from '../core/security/index.ts';
import { createErrorHandler } from '../middleware/errorHandler.middleware.ts';
import { createWorkflowRouter } from './workflow.routes.ts';

function listen(app: express.Express) {
  const server = app.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected server to bind to a TCP port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function buildApp(workflows: WorkflowRuntime) {
  const app = express();
  app.use(express.json());
  app.use('/workflow', createWorkflowRouter(workflows));
  app.use(createErrorHandler({ observability: new ObservabilityService(), security: new SecurityService() }));
  return app;
}

describe('workflow routes', () => {
  test('lists registered definitions', async () => {
    const workflows = new WorkflowRuntime();
    workflows.defineWorkflow({
      id: 'greet',
      name: 'Greet',
      description: 'Say hello',
      steps: [{ id: 'say-hello', name: 'Say hello', execute: (ctx) => `Hello, ${String(ctx.input.name)}!` }],
    });

    const { server, baseUrl } = listen(buildApp(workflows));
    try {
      const response = await fetch(`${baseUrl}/workflow/definitions`);
      const body = (await response.json()) as { definitions: { id: string; stepCount: number }[] };
      assert.equal(response.status, 200);
      assert.deepEqual(body.definitions, [
        { id: 'greet', name: 'Greet', description: 'Say hello', stepCount: 1 },
      ]);
    } finally {
      server.close();
    }
  });

  test('runs a workflow and returns the finished run', async () => {
    const workflows = new WorkflowRuntime();
    workflows.defineWorkflow({
      id: 'greet',
      name: 'Greet',
      description: 'Say hello',
      steps: [{ id: 'say-hello', name: 'Say hello', execute: (ctx) => `Hello, ${String(ctx.input.name)}!` }],
    });

    const { server, baseUrl } = listen(buildApp(workflows));
    try {
      const response = await fetch(`${baseUrl}/workflow/greet/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { name: 'framework' } }),
      });
      const run = (await response.json()) as { status: string; results: Record<string, unknown> };
      assert.equal(response.status, 200);
      assert.equal(run.status, 'completed');
      assert.equal(run.results['say-hello'], 'Hello, framework!');

      const runsResponse = await fetch(`${baseUrl}/workflow/runs`);
      const runsBody = (await runsResponse.json()) as { runs: { id: string }[] };
      assert.equal(runsBody.runs.length, 1);

      const runResponse = await fetch(`${baseUrl}/workflow/runs/${runsBody.runs[0]!.id}`);
      assert.equal(runResponse.status, 200);
    } finally {
      server.close();
    }
  });

  test('running an unregistered definition returns 404', async () => {
    const { server, baseUrl } = listen(buildApp(new WorkflowRuntime()));
    try {
      const response = await fetch(`${baseUrl}/workflow/missing/run`, { method: 'POST' });
      assert.equal(response.status, 404);
    } finally {
      server.close();
    }
  });

  test('getting an unknown run returns 404', async () => {
    const { server, baseUrl } = listen(buildApp(new WorkflowRuntime()));
    try {
      const response = await fetch(`${baseUrl}/workflow/runs/missing`);
      assert.equal(response.status, 404);
    } finally {
      server.close();
    }
  });
});
