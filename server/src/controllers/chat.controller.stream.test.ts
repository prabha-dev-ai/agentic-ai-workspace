import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { StreamManager } from '../core/streaming/index.ts';
import { SecurityService } from '../core/security/index.ts';
import { createChatStreamHandler } from './chat.controller.ts';
import type { LlmService } from '../services/llm.service.ts';

function fakeLlmService(answer: string): LlmService {
  return {
    async generateResponse() {
      return { answer };
    },
  };
}

function listen(app: express.Express) {
  const server = app.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected server to bind to a TCP port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function buildApp(llmService: LlmService) {
  const app = express();
  app.get('/chat/stream', createChatStreamHandler(llmService, new StreamManager(), new SecurityService()));
  return app;
}

describe('GET /chat/stream', () => {
  test('streams chunk events followed by a completed event', async () => {
    const { server, baseUrl } = listen(buildApp(fakeLlmService('hello there')));
    try {
      const response = await fetch(`${baseUrl}/chat/stream?message=hi`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

      const body = await response.text();
      assert.match(body, /event: chunk\ndata: \{"data":"hello"\}/);
      assert.match(body, /event: chunk\ndata: \{"data":"there"\}/);
      assert.match(body, /event: completed\ndata: \{"chunkCount":2\}/);
    } finally {
      server.close();
    }
  });

  test('rejects a missing message with 400', async () => {
    const { server, baseUrl } = listen(buildApp(fakeLlmService('unused')));
    try {
      const response = await fetch(`${baseUrl}/chat/stream`);
      assert.equal(response.status, 400);
    } finally {
      server.close();
    }
  });

  test('rejects a message that fails the security policy with 400', async () => {
    const { server, baseUrl } = listen(buildApp(fakeLlmService('unused')));
    try {
      const response = await fetch(`${baseUrl}/chat/stream?message=${encodeURIComponent('bad\x00char')}`);
      assert.equal(response.status, 400);
    } finally {
      server.close();
    }
  });
});
