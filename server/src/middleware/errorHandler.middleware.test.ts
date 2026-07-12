import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ObservabilityService } from '../core/observability/index.ts';
import { SecurityService } from '../core/security/index.ts';
import { ValidationError } from '../core/security/index.ts';
import { WorkflowError } from '../core/workflow/index.ts';
import { HttpError } from './HttpError.ts';
import { createErrorHandler } from './errorHandler.middleware.ts';

function listen(app: express.Express) {
  const server = app.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected server to bind to a TCP port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function buildApp() {
  const observability = new ObservabilityService();
  const security = new SecurityService();
  const app = express();

  app.get('/http-error', () => {
    throw new HttpError(404, 'not found here');
  });
  app.get('/validation-error', () => {
    throw new ValidationError('bad input');
  });
  app.get('/workflow-error', () => {
    throw new WorkflowError('bad workflow');
  });
  app.get('/unexpected', () => {
    throw new Error('super secret internal detail');
  });
  app.get('/async-rejection', async () => {
    throw new HttpError(409, 'conflict');
  });

  app.use(createErrorHandler({ observability, security }));

  return app;
}

describe('createErrorHandler', () => {
  test('HttpError maps to its own status code and message', async () => {
    const { server, baseUrl } = listen(buildApp());
    try {
      const response = await fetch(`${baseUrl}/http-error`);
      const body = (await response.json()) as { error: string };
      assert.equal(response.status, 404);
      assert.equal(body.error, 'not found here');
    } finally {
      server.close();
    }
  });

  test('ValidationError maps to 400', async () => {
    const { server, baseUrl } = listen(buildApp());
    try {
      const response = await fetch(`${baseUrl}/validation-error`);
      const body = (await response.json()) as { error: string };
      assert.equal(response.status, 400);
      assert.equal(body.error, 'bad input');
    } finally {
      server.close();
    }
  });

  test('WorkflowError maps to 400', async () => {
    const { server, baseUrl } = listen(buildApp());
    try {
      const response = await fetch(`${baseUrl}/workflow-error`);
      assert.equal(response.status, 400);
    } finally {
      server.close();
    }
  });

  test('an unrecognized error becomes a generic 500 — no internal detail leaks', async () => {
    const { server, baseUrl } = listen(buildApp());
    try {
      const response = await fetch(`${baseUrl}/unexpected`);
      const body = (await response.json()) as { error: string };
      assert.equal(response.status, 500);
      assert.equal(body.error, 'Internal server error.');
      assert.ok(!body.error.includes('secret'));
    } finally {
      server.close();
    }
  });

  test('a rejected promise from an async handler is forwarded too', async () => {
    const { server, baseUrl } = listen(buildApp());
    try {
      const response = await fetch(`${baseUrl}/async-rejection`);
      assert.equal(response.status, 409);
    } finally {
      server.close();
    }
  });
});
