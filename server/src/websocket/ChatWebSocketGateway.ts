import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { streamChatResponse } from '../services/chat-stream.service.ts';
import type { LlmService } from '../services/llm.service.ts';
import type { StreamManager } from '../core/streaming/index.ts';
import type { SecurityService } from '../core/security/index.ts';
import type { ObservabilityService } from '../core/observability/index.ts';
import type { AuthService, Principal } from '../core/auth/index.ts';

export interface ChatWebSocketDependencies {
  llmService: LlmService;
  streaming: StreamManager;
  security: SecurityService;
  observability: ObservabilityService;
  auth: AuthService;
}

type RequestWithPrincipal = IncomingMessage & { principal?: Principal };

// Browsers' native WebSocket API can't set an Authorization header on the
// upgrade request, so — unlike every REST route — credentials here are
// accepted two ways: the standard header (for non-browser clients), or an
// "apiKey"/"token" query parameter (for browser EventSource-style
// clients). Only used when AuthService.isEnabled() — a zero-config
// deployment accepts every connection unchanged from AAI-037.
function extractCredential(req: IncomingMessage): { scheme: string; credential: string } | undefined {
  const header = req.headers.authorization;
  if (header) {
    const [scheme, credential] = header.split(' ');
    if (scheme && credential) {
      return { scheme, credential };
    }
  }

  const url = new URL(req.url ?? '', 'http://localhost');
  const apiKey = url.searchParams.get('apiKey');
  if (apiKey) {
    return { scheme: 'ApiKey', credential: apiKey };
  }
  const token = url.searchParams.get('token');
  if (token) {
    return { scheme: 'Bearer', credential: token };
  }

  return undefined;
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
  const { llmService, streaming, security, observability, auth } = deps;
  const logger = observability.getLogger('websocket.chat');
  const auditLogger = observability.getLogger('security.audit');

  const wss = new WebSocketServer({
    server,
    path: '/ws/chat',
    verifyClient: (info, callback) => {
      if (!auth.isEnabled()) {
        callback(true);
        return;
      }

      const credential = extractCredential(info.req);
      const principal = credential ? auth.authenticate(credential.scheme, credential.credential) : undefined;

      if (!principal) {
        auditLogger.warn('websocket authentication failed', { path: '/ws/chat' });
        callback(false, 401, 'Unauthorized');
        return;
      }

      auditLogger.info('websocket authentication succeeded', {
        subject: principal.subject,
        method: principal.authMethod,
      });
      (info.req as RequestWithPrincipal).principal = principal;
      callback(true);
    },
  });

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const principal = (req as RequestWithPrincipal).principal;
    logger.info('client connected', principal ? { subject: principal.subject } : {});

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
