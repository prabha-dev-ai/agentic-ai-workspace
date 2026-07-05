import { Router } from 'express';
import { createChatHandler } from '../controllers/chat.controller.ts';
import type { LlmService } from '../services/llm.service.ts';

// Paths here are relative to the mount point chosen in app.ts ("/chat"),
// so this file only maps HTTP verbs to controllers. Dependencies flow in
// from the composition root and down into the handlers.
export function createChatRouter(llmService: LlmService): Router {
  const chatRouter = Router();

  chatRouter.post('/', createChatHandler(llmService));

  return chatRouter;
}
