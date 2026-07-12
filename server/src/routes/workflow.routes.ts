import { Router } from 'express';
import {
  createGetWorkflowRunHandler,
  createListWorkflowDefinitionsHandler,
  createListWorkflowRunsHandler,
  createRunWorkflowHandler,
} from '../controllers/workflow.controller.ts';
import type { WorkflowRuntime } from '../core/workflow/index.ts';

// Mounted at "/workflow" in app.ts. Thin REST facade over the pre-existing
// WorkflowRuntime — defineWorkflow() stays a startup/plugin-time concern
// (definitions are registered in bootstrap.ts or by plugins, never via
// HTTP), so this router only exposes what's already registered and lets
// callers run it.
export function createWorkflowRouter(workflows: WorkflowRuntime): Router {
  const workflowRouter = Router();

  workflowRouter.get('/definitions', createListWorkflowDefinitionsHandler(workflows));
  workflowRouter.post('/:definitionId/run', createRunWorkflowHandler(workflows));
  workflowRouter.get('/runs', createListWorkflowRunsHandler(workflows));
  workflowRouter.get('/runs/:runId', createGetWorkflowRunHandler(workflows));

  return workflowRouter;
}
