import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { streamChatResponse } from '../services/chat-stream.service.ts';
import type { LlmService } from '../services/llm.service.ts';
import type { StreamManager } from '../core/streaming/index.ts';
import type { SecurityService } from '../core/security/index.ts';
import type { ObservabilityService } from '../core/observability/index.ts';

export interface ChatWebSocketDependencies {
  llmService: LlmService;
  streaming: StreamManager;
  security: SecurityService;
  observability: ObservabilityService;
}

// The WebSocket transport for chat: a long-lived duplex sibling to the SSE
// endpoint (routes/chat.routes.ts), sharing the exact same
// streamChatResponse() helper so both transports forward identical
// stream semantics over different wire formats. One connection accepts
// many sequential messages — each becomes its own Stream — rather than
// closing after the first reply, since a socket (unlike an EventSource
// request) is naturally a whole conversation's channel.
//
// The WebSocket server is constructed only here — the same single-
// construction-site discipline core/architecture.test.ts already enforces
// for the framework's other external clients, extended to the inbound
// transport server.ts wires up once app.listen() has an http.Server.
export function createChatWebSocketGateway(
  server: HttpServer,
  deps: ChatWebSocketDependencies,
): WebSocketServer {
  const { llmService, streaming, security, observability } = deps;
  const logger = observability.getLogger('websocket.chat');
  const wss = new WebSocketServer({ server, path: '/ws/chat' });

  wss.on('connection', (socket: WebSocket) => {
    logger.info('client connected');

    socket.on('message', (raw) => {
      let message: string;

      try {
        const parsed: unknown = JSON.parse(raw.toString());
        const candidate = (parsed as { message?: unknown }).message;

        if (typeof candidate !== 'string' || candidate.trim() === '') {
          throw new Error('"message" is required and must be a non-empty string.');
        }
        security.validateInput(candidate, 'message');
        message = candidate;
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return;
      }

      const stream = streamChatResponse(streaming, llmService, message);

      stream.subscribe((event) => {
        if (socket.readyState !== socket.OPEN) {
          return;
        }

        if (event.type === 'chunk') {
          socket.send(JSON.stringify({ type: 'chunk', data: event.data }));
        } else if (event.type === 'completed') {
          socket.send(JSON.stringify({ type: 'completed' }));
        } else if (event.type === 'error') {
          socket.send(JSON.stringify({ type: 'error', error: event.error }));
        }
      });
    });

    socket.on('close', () => {
      logger.info('client disconnected');
    });
  });

  return wss;
}
