import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { StreamManager } from '../core/streaming/index.ts';
import { SecurityService } from '../core/security/index.ts';
import { ObservabilityService } from '../core/observability/index.ts';
import { createChatWebSocketGateway } from './ChatWebSocketGateway.ts';
import type { LlmService } from '../services/llm.service.ts';

function fakeLlmService(answer: string | Error): LlmService {
  return {
    async generateResponse() {
      if (answer instanceof Error) {
        throw answer;
      }
      return { answer };
    },
  };
}

function listen(server: http.Server) {
  server.listen(0);
  return new Promise<string>((resolve) => {
    server.once('listening', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected server to bind to a TCP port');
      }
      resolve(`ws://127.0.0.1:${address.port}/ws/chat`);
    });
  });
}

describe('ChatWebSocketGateway', () => {
  test('forwards chunk events then a completed event for a valid message', async () => {
    const server = http.createServer();
    createChatWebSocketGateway(server, {
      llmService: fakeLlmService('hello there'),
      streaming: new StreamManager(),
      security: new SecurityService(),
      observability: new ObservabilityService(),
    });

    const url = await listen(server);
    try {
      const socket = new WebSocket(url);
      const frames: Record<string, unknown>[] = [];

      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => socket.send(JSON.stringify({ message: 'hi' })));
        socket.on('message', (data) => {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          frames.push(frame);
          if (frame.type === 'completed') {
            resolve();
          }
        });
        socket.on('error', reject);
      });

      assert.deepEqual(frames, [
        { type: 'chunk', data: 'hello' },
        { type: 'chunk', data: 'there' },
        { type: 'completed' },
      ]);
      socket.close();
    } finally {
      server.close();
    }
  });

  test('sends an error frame for a malformed message without closing the socket', async () => {
    const server = http.createServer();
    createChatWebSocketGateway(server, {
      llmService: fakeLlmService('unused'),
      streaming: new StreamManager(),
      security: new SecurityService(),
      observability: new ObservabilityService(),
    });

    const url = await listen(server);
    try {
      const socket = new WebSocket(url);

      const frame = await new Promise<Record<string, unknown>>((resolve, reject) => {
        socket.on('open', () => socket.send(JSON.stringify({})));
        socket.on('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
        socket.on('error', reject);
      });

      assert.equal(frame.type, 'error');
      assert.equal(socket.readyState, socket.OPEN);
      socket.close();
    } finally {
      server.close();
    }
  });
});
