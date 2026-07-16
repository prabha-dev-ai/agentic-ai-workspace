import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ObservabilityService, MemoryLogSink } from '../core/observability/index.ts';
import { TraceManager } from '../core/tracing/index.ts';
import { MetricsRegistry } from '../core/metrics/index.ts';
import { ApiKeyStore, AuthService } from '../core/auth/index.ts';
import { createAuthenticateMiddleware } from './authenticate.middleware.ts';

function listen(app: express.Express) {
  const server = app.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected server to bind to a TCP port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function buildApp(auth: AuthService, sink: MemoryLogSink, metrics: MetricsRegistry) {
  const observability = new ObservabilityService();
  observability.addSink(sink);
  const tracing = new TraceManager();

  const app = express();
  app.use(createAuthenticateMiddleware({ auth, observability, tracing, metrics }));
  app.get('/whoami', (_req, res) => {
    const principal = (res.locals as Record<string, unknown>).principal;
    res.status(200).json({ principal: principal ?? null });
  });
  return app;
}

describe('createAuthenticateMiddleware', () => {
  test('attaches no principal and never rejects when no Authorization header is sent', async () => {
    const auth = new AuthService({ apiKeyStore: new ApiKeyStore([{ key: 'k1', subject: 'alice', roles: ['admin'] }]) });
    const { server, baseUrl } = listen(buildApp(auth, new MemoryLogSink(), new MetricsRegistry()));
    try {
      const response = await fetch(`${baseUrl}/whoami`);
      const body = (await response.json()) as { principal: unknown };
      assert.equal(response.status, 200);
      assert.equal(body.principal, null);
    } finally {
      server.close();
    }
  });

  test('attaches the principal for a valid API key', async () => {
    const auth = new AuthService({ apiKeyStore: new ApiKeyStore([{ key: 'k1', subject: 'alice', roles: ['admin'] }]) });
    const sink = new MemoryLogSink();
    const { server, baseUrl } = listen(buildApp(auth, sink, new MetricsRegistry()));
    try {
      const response = await fetch(`${baseUrl}/whoami`, { headers: { Authorization: 'ApiKey k1' } });
      const body = (await response.json()) as { principal: { subject: string } };
      assert.equal(body.principal.subject, 'alice');
      assert.ok(sink.entries.some((entry) => entry.message === 'authentication succeeded'));
    } finally {
      server.close();
    }
  });

  test('does not attach a principal for an invalid key, and audit-logs the failure', async () => {
    const auth = new AuthService({ apiKeyStore: new ApiKeyStore([{ key: 'k1', subject: 'alice', roles: ['admin'] }]) });
    const sink = new MemoryLogSink();
    const { server, baseUrl } = listen(buildApp(auth, sink, new MetricsRegistry()));
    try {
      const response = await fetch(`${baseUrl}/whoami`, { headers: { Authorization: 'ApiKey wrong' } });
      const body = (await response.json()) as { principal: unknown };
      assert.equal(response.status, 200);
      assert.equal(body.principal, null);

      const failureEntry = sink.entries.find((entry) => entry.message === 'authentication failed');
      assert.ok(failureEntry);
      // Never logs the raw credential.
      assert.equal(JSON.stringify(failureEntry?.fields).includes('wrong'), false);
    } finally {
      server.close();
    }
  });

  test('records auth_attempts_total by method and result', async () => {
    const auth = new AuthService({ apiKeyStore: new ApiKeyStore([{ key: 'k1', subject: 'alice', roles: ['admin'] }]) });
    const metrics = new MetricsRegistry();
    const { server, baseUrl } = listen(buildApp(auth, new MemoryLogSink(), metrics));
    try {
      await fetch(`${baseUrl}/whoami`, { headers: { Authorization: 'ApiKey k1' } });
      await fetch(`${baseUrl}/whoami`, { headers: { Authorization: 'ApiKey wrong' } });

      const snapshot = metrics.collect().find((entry) => entry.name === 'auth_attempts_total');
      assert.ok(snapshot);
      if (snapshot.type !== 'counter') {
        throw new Error('expected auth_attempts_total to be a counter');
      }
      const success = snapshot.samples.find((sample) => sample.labels.result === 'success');
      const failure = snapshot.samples.find((sample) => sample.labels.result === 'failure');
      assert.equal(success?.value, 1);
      assert.equal(failure?.value, 1);
    } finally {
      server.close();
    }
  });
});
