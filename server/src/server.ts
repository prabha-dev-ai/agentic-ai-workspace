import { app, container } from './app.ts';
import { env } from './config/env.ts';
import { TOKENS } from './core/tokens.ts';
import { createChatWebSocketGateway } from './websocket/ChatWebSocketGateway.ts';

const server = app.listen(env.port, () => {
  console.log(`[server] Running at http://localhost:${env.port} (${env.nodeEnv})`);
});

// Attached to the same http.Server app.listen() already created — the
// WebSocket gateway upgrades connections on that one listener rather than
// opening a second port.
createChatWebSocketGateway(server, {
  llmService: container.get(TOKENS.llmService),
  streaming: container.get(TOKENS.streaming),
  security: container.get(TOKENS.security),
  observability: container.get(TOKENS.observability),
});
