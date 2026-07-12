import { Router } from 'express';
import { createChatHandler, createChatStreamHandler } from '../controllers/chat.controller.ts';
import type { LlmService } from '../services/llm.service.ts';
import type { StreamManager } from '../core/streaming/index.ts';
import type { SecurityService } from '../core/security/index.ts';

// Paths here are relative to the mount point chosen in app.ts ("/chat"),
// so this file only maps HTTP verbs to controllers. Dependencies flow in
// from the composition root and down into the handlers.
export function createChatRouter(
  llmService: LlmService,
  streaming: StreamManager,
  security: SecurityService,
): Router {
  const chatRouter = Router();

  chatRouter.post('/', createChatHandler(llmService));
  chatRouter.get('/stream', createChatStreamHandler(llmService, streaming, security));

  return chatRouter;
}
