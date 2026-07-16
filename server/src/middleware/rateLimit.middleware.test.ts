import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ObservabilityService, MemoryLogSink } from '../core/observability/index.ts';
import { MetricsRegistry } from '../core/metrics/index.ts';
import { RateLimiter } from '../core/auth/index.ts';
import { createErrorHandler } from './errorHandler.middleware.ts';
import { SecurityService } from '../core/security/index.ts';
import { createRateLimitMiddleware } from './rateLimit.middleware.ts';

function listen(app: express.Express) {
  const server = app.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected server to bind to a TCP port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function buildApp(rateLimiter: RateLimiter, sink: MemoryLogSink, metrics: MetricsRegistry) {
  const observability = new ObservabilityService();
  observability.addSink(sink);
  const security = new SecurityService();

  const app = express();
  app.use(createRateLimitMiddleware({ rateLimiter, observability, metrics }));
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
  app.use(createErrorHandler({ observability, security }));
  return app;
}

describe('createRateLimitMiddleware', () => {
  test('allows requests under the limit, and reports remaining', async () => {
    const { server, baseUrl } = listen(
      buildApp(new RateLimiter({ windowMs: 60_000, max: 5 }), new MemoryLogSink(), new MetricsRegistry()),
    );
    try {
      const response = await fetch(`${baseUrl}/ping`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-ratelimit-remaining'), '4');
    } finally {
      server.close();
    }
  });

  test('rejects with 429 and a Retry-After header once the limit is exceeded', async () => {
    const sink = new MemoryLogSink();
    const metrics = new MetricsRegistry();
    const { server, baseUrl } = listen(buildApp(new RateLimiter({ windowMs: 60_000, max: 1 }), sink, metrics));
    try {
      const first = await fetch(`${baseUrl}/ping`);
      assert.equal(first.status, 200);

      const second = await fetch(`${baseUrl}/ping`);
      const body = (await second.json()) as { error: string };
      assert.equal(second.status, 429);
      assert.ok(second.headers.get('retry-after'));
      assert.match(body.error, /rate limit/i);

      assert.ok(sink.entries.some((entry) => entry.message === 'rate limit exceeded'));

      const snapshot = metrics.collect().find((entry) => entry.name === 'rate_limit_exceeded_total');
      assert.ok(snapshot);
      if (snapshot.type !== 'counter') {
        throw new Error('expected rate_limit_exceeded_total to be a counter');
      }
      assert.equal(snapshot.samples[0]?.value, 1);
    } finally {
      server.close();
    }
  });
});
