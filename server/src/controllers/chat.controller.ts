import type { Request, Response } from 'express';
import type { LlmService } from '../services/llm.service.ts';
import type { StreamManager } from '../core/streaming/index.ts';
import type { SecurityService } from '../core/security/index.ts';
import { streamChatResponse } from '../services/chat-stream.service.ts';

// Controllers only translate HTTP <-> service calls: validate input,
// pick status codes, shape the JSON. The service arrives via injection —
// the controller never constructs its own dependencies.
export function createChatHandler(llmService: LlmService) {
  return async function handleChat(req: Request, res: Response): Promise<void> {
    // Express 5 leaves req.body undefined when no JSON body was sent.
    const message: unknown = req.body?.message;

    if (typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({
        error: '"message" is required and must be a non-empty string.',
      });
      return;
    }

    try {
      const result = await llmService.generateResponse(message);
      res.status(200).json({ reply: result.answer });
    } catch (error) {
      // Log the real error for us; send a generic message to the client so
      // internal details (provider, keys, stack traces) never leak.
      console.error('[chat] Failed to generate response:', error);
      res.status(500).json({ error: 'Failed to generate a response.' });
    }
  };
}

// GET, not POST: EventSource (the browser SSE client) only ever issues
// GET requests, so the message travels as a query parameter instead of a
// JSON body — the one deliberate exception to this codebase's "validate
// req.body" convention.
export function createChatStreamHandler(
  llmService: LlmService,
  streaming: StreamManager,
  security: SecurityService,
) {
  return function handleChatStream(req: Request, res: Response): void {
    const message = req.query.message;

    if (typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({
        error: '"message" query parameter is required and must be a non-empty string.',
      });
      return;
    }

    try {
      security.validateInput(message, 'message');
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    const stream = streamChatResponse(streaming, llmService, message);

    const unsubscribe = stream.subscribe((event) => {
      if (event.type === 'chunk') {
        res.write(`event: chunk\ndata: ${JSON.stringify({ data: event.data })}\n\n`);
      } else if (event.type === 'completed') {
        res.write(`event: completed\ndata: ${JSON.stringify({ chunkCount: event.chunkCount })}\n\n`);
        res.end();
      } else if (event.type === 'error') {
        res.write(`event: error\ndata: ${JSON.stringify({ error: event.error })}\n\n`);
        res.end();
      }
    });

    // The client walking away mid-stream is not a stream failure — it's a
    // cancellation, the same distinction StreamState draws between Error
    // and Cancelled.
    req.on('close', () => {
      unsubscribe();
      if (stream.state === 'active' || stream.state === 'pending') {
        stream.cancel();
      }
    });
  };
}
