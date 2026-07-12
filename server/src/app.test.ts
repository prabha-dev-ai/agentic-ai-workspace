import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from './app.ts';

function listen() {
  const server = app.listen(0);
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Expected server to bind to a TCP port');
  }

  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

test('GET /diagnostics reports version, plugin count, and uptime', async () => {
  const { server, baseUrl } = listen();

  try {
    const response = await fetch(`${baseUrl}/diagnostics`);
    const body = (await response.json()) as {
      version: string;
      pluginCount: number;
      uptime: number;
      diagnostics: Record<string, unknown>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.version, '2.0.0');
    assert.ok(Number.isInteger(body.pluginCount));
    assert.ok(body.pluginCount > 0);
    assert.ok(body.uptime >= 0);
    // AAI-037: additive extension — every subsystem's own diagnostics,
    // nested under a new field, alongside the unchanged v2.0.0 fields above.
    for (const key of ['observability', 'tracing', 'metrics', 'streaming', 'workflows', 'security']) {
      assert.ok(key in body.diagnostics, `expected diagnostics.${key}`);
    }
  } finally {
    server.close();
  }
});

test('GET /health reports liveness', async () => {
  const { server, baseUrl } = listen();
  try {
    const response = await fetch(`${baseUrl}/health`);
    const body = (await response.json()) as { status: string; uptime: number };
    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.ok(body.uptime >= 0);
  } finally {
    server.close();
  }
});

test('GET /ready reports readiness, with a not-configured check for unconfigured backends', async () => {
  const { server, baseUrl } = listen();
  try {
    const response = await fetch(`${baseUrl}/ready`);
    const body = (await response.json()) as { status: string; checks: Record<string, { status: string }> };
    assert.equal(response.status, 200);
    assert.equal(body.status, 'ready');
    assert.ok(body.checks.postgres);
    assert.ok(body.checks.redis);
  } finally {
    server.close();
  }
});

test('GET /metrics returns Prometheus text exposition format', async () => {
  const { server, baseUrl } = listen();
  try {
    const response = await fetch(`${baseUrl}/metrics`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
    assert.match(body, /# TYPE /);
  } finally {
    server.close();
  }
});

test('GET /openapi.json describes the gateway routes', async () => {
  const { server, baseUrl } = listen();
  try {
    const response = await fetch(`${baseUrl}/openapi.json`);
    const body = (await response.json()) as { openapi: string; paths: Record<string, unknown> };
    assert.equal(response.status, 200);
    assert.equal(body.openapi, '3.0.3');
    for (const path of ['/health', '/chat', '/chat/stream', '/agent/sessions', '/workflow/definitions']) {
      assert.ok(path in body.paths, `expected an OpenAPI entry for ${path}`);
    }
  } finally {
    server.close();
  }
});

test('GET /workflow/definitions lists whatever workflows are registered at bootstrap', async () => {
  const { server, baseUrl } = listen();
  try {
    const response = await fetch(`${baseUrl}/workflow/definitions`);
    const body = (await response.json()) as { definitions: unknown[] };
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(body.definitions));
  } finally {
    server.close();
  }
});

test('an unmatched route reports a 404 with a JSON body', async () => {
  const { server, baseUrl } = listen();
  try {
    const response = await fetch(`${baseUrl}/no-such-route`);
    const body = (await response.json()) as { error: string };
    assert.equal(response.status, 404);
    assert.match(body.error, /no-such-route/);
  } finally {
    server.close();
  }
});
