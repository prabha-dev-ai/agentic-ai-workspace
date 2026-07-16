import { Router } from 'express';
import {
  createGetWorkflowRunHandler,
  createListWorkflowDefinitionsHandler,
  createListWorkflowRunsHandler,
  createRunWorkflowHandler,
} from '../controllers/workflow.controller.ts';
import type { WorkflowRuntime } from '../core/workflow/index.ts';
import { Permission } from '../core/auth/index.ts';
import type { PermissionGuard } from '../middleware/authorize.middleware.ts';

// Mounted at "/workflow" in app.ts. Thin REST facade over the pre-existing
// WorkflowRuntime — defineWorkflow() stays a startup/plugin-time concern
// (definitions are registered in bootstrap.ts or by plugins, never via
// HTTP), so this router only exposes what's already registered and lets
// callers run it. requirePermission is a no-op when auth is unconfigured
// (see middleware/authorize.middleware.ts).
export function createWorkflowRouter(workflows: WorkflowRuntime, requirePermission: PermissionGuard): Router {
  const workflowRouter = Router();

  workflowRouter.get(
    '/definitions',
    requirePermission(Permission.WorkflowRead),
    createListWorkflowDefinitionsHandler(workflows),
  );
  workflowRouter.post(
    '/:definitionId/run',
    requirePermission(Permission.WorkflowWrite),
    createRunWorkflowHandler(workflows),
  );
  workflowRouter.get('/runs', requirePermission(Permission.WorkflowRead), createListWorkflowRunsHandler(workflows));
  workflowRouter.get(
    '/runs/:runId',
    requirePermission(Permission.WorkflowRead),
    createGetWorkflowRunHandler(workflows),
  );

  return workflowRouter;
}
