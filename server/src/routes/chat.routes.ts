import { Router } from 'express';
import { createChatHandler, createChatStreamHandler } from '../controllers/chat.controller.ts';
import type { LlmService } from '../services/llm.service.ts';
import type { StreamManager } from '../core/streaming/index.ts';
import type { SecurityService } from '../core/security/index.ts';
import { Permission } from '../core/auth/index.ts';
import type { PermissionGuard } from '../middleware/authorize.middleware.ts';

// Paths here are relative to the mount point chosen in app.ts ("/chat"),
// so this file only maps HTTP verbs to controllers. Dependencies flow in
// from the composition root and down into the handlers. requirePermission
// is a no-op when AuthService.isEnabled() is false (see
// middleware/authorize.middleware.ts) — a zero-config deployment behaves
// exactly like AAI-037, unchanged.
export function createChatRouter(
  llmService: LlmService,
  streaming: StreamManager,
  security: SecurityService,
  requirePermission: PermissionGuard,
): Router {
  const chatRouter = Router();

  chatRouter.post('/', requirePermission(Permission.ChatWrite), createChatHandler(llmService));
  chatRouter.get(
    '/stream',
    requirePermission(Permission.ChatWrite),
    createChatStreamHandler(llmService, streaming, security),
  );

  return chatRouter;
}
