import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamManager } from '../core/streaming/index.ts';
import { streamChatResponse } from './chat-stream.service.ts';
import type { LlmService } from './llm.service.ts';

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

describe('streamChatResponse', () => {
  test('pushes the answer word-by-word, then completes', async () => {
    const streaming = new StreamManager();
    const stream = streamChatResponse(streaming, fakeLlmService('hello there world'), 'hi');

    const chunks: string[] = [];
    let completed = false;

    await new Promise<void>((resolve, reject) => {
      stream.subscribe((event) => {
        if (event.type === 'chunk') {
          chunks.push(event.data);
        } else if (event.type === 'completed') {
          completed = true;
          resolve();
        } else if (event.type === 'error') {
          reject(new Error(event.error));
        }
      });
    });

    assert.deepEqual(chunks, ['hello', 'there', 'world']);
    assert.equal(completed, true);
  });

  test('a failing LlmService fails the stream instead of throwing', async () => {
    const streaming = new StreamManager();
    const stream = streamChatResponse(streaming, fakeLlmService(new Error('provider down')), 'hi');

    const error = await new Promise<string>((resolve) => {
      stream.subscribe((event) => {
        if (event.type === 'error') {
          resolve(event.error);
        }
      });
    });

    assert.equal(error, 'provider down');
    assert.equal(stream.state, 'error');
  });
});
