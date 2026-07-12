import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ObservabilityService, MemoryLogSink } from '../core/observability/index.ts';
import { TraceManager, InMemorySpanExporter } from '../core/tracing/index.ts';
import { MetricsRegistry } from '../core/metrics/index.ts';
import { createRequestContextMiddleware } from './requestContext.middleware.ts';

function listen(app: express.Express) {
  const server = app.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected server to bind to a TCP port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('createRequestContextMiddleware', () => {
  test('assigns an X-Request-Id header and logs/traces/measures the request', async () => {
    const observability = new ObservabilityService();
    const sink = new MemoryLogSink();
    observability.addSink(sink);

    const tracing = new TraceManager();
    const exporter = new InMemorySpanExporter();
    tracing.addExporter(exporter);

    const metrics = new MetricsRegistry();

    const app = express();
    app.use(createRequestContextMiddleware({ observability, tracing, metrics }));
    app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));

    const { server, baseUrl } = listen(app);
    try {
      const response = await fetch(`${baseUrl}/ping`);
      const requestId = response.headers.get('x-request-id');

      assert.equal(response.status, 200);
      assert.ok(requestId && requestId.length > 0);

      // Give the "finish" listener a tick to run — it fires after the
      // response is flushed, which can race the fetch() promise resolving.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const entries = sink.entries;
      assert.ok(entries.some((entry) => entry.message === 'request started'));
      assert.ok(entries.some((entry) => entry.message === 'request completed'));
      assert.ok(entries.every((entry) => entry.correlationId === requestId));

      assert.equal(exporter.spans.length, 1);
      assert.equal(exporter.spans[0]?.name, 'GET /ping');

      const requestsTotal = metrics.collect().find((snapshot) => snapshot.name === 'http_requests_total');
      assert.ok(requestsTotal);
      if (requestsTotal.type !== 'counter') {
        throw new Error('expected http_requests_total to be a counter');
      }
      assert.equal(requestsTotal.samples[0]?.value, 1);
    } finally {
      server.close();
    }
  });

  test('reuses an inbound X-Request-Id instead of generating a new one', async () => {
    const observability = new ObservabilityService();
    const tracing = new TraceManager();
    const metrics = new MetricsRegistry();

    const app = express();
    app.use(createRequestContextMiddleware({ observability, tracing, metrics }));
    app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));

    const { server, baseUrl } = listen(app);
    try {
      const response = await fetch(`${baseUrl}/ping`, { headers: { 'x-request-id': 'caller-supplied-id' } });
      assert.equal(response.headers.get('x-request-id'), 'caller-supplied-id');
    } finally {
      server.close();
    }
  });
});
