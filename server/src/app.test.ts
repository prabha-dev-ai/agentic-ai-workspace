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
    const body = (await response.json()) as { version: string; pluginCount: number; uptime: number };

    assert.equal(response.status, 200);
    assert.equal(body.version, '2.0.0');
    assert.ok(Number.isInteger(body.pluginCount));
    assert.ok(body.pluginCount > 0);
    assert.ok(body.uptime >= 0);
  } finally {
    server.close();
  }
});
