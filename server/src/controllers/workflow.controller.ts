import type { Request, Response } from 'express';
import type { WorkflowRuntime, WorkflowRun } from '../core/workflow/index.ts';
import { HttpError } from '../middleware/HttpError.ts';
import { optionalRecord, requireParam } from '../middleware/validation.ts';

function serializeRun(run: WorkflowRun) {
  return {
    id: run.id,
    definitionId: run.definitionId,
    definitionName: run.definitionName,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    endedAt: run.endedAt.toISOString(),
    durationMs: run.durationMs,
    input: run.input,
    results: run.results,
    steps: run.steps.map((step) => ({
      ...step,
      startedAt: step.startedAt.toISOString(),
      endedAt: step.endedAt.toISOString(),
    })),
    error: run.error,
  };
}

/** GET /workflow/definitions — every workflow this process can run. */
export function createListWorkflowDefinitionsHandler(workflows: WorkflowRuntime) {
  return (_req: Request, res: Response): void => {
    res.status(200).json({
      definitions: workflows.listDefinitions().map((definition) => ({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        stepCount: definition.steps.length,
      })),
    });
  };
}

/** POST /workflow/:definitionId/run — run a registered workflow to completion. */
export function createRunWorkflowHandler(workflows: WorkflowRuntime) {
  return async (req: Request, res: Response): Promise<void> => {
    const definitionId = requireParam(req.params, 'definitionId');
    const input = optionalRecord(req.body, 'input') ?? {};

    if (!workflows.getDefinition(definitionId)) {
      throw new HttpError(404, `No workflow definition "${definitionId}" is registered.`);
    }

    const run = await workflows.run(definitionId, input);
    res.status(200).json(serializeRun(run));
  };
}

/** GET /workflow/runs — every run retained by the runtime, oldest first. */
export function createListWorkflowRunsHandler(workflows: WorkflowRuntime) {
  return (_req: Request, res: Response): void => {
    res.status(200).json({ runs: workflows.listRuns().map(serializeRun) });
  };
}

/** GET /workflow/runs/:runId */
export function createGetWorkflowRunHandler(workflows: WorkflowRuntime) {
  return (req: Request, res: Response): void => {
    const runId = requireParam(req.params, 'runId');
    const run = workflows.getRun(runId);
    if (!run) {
      throw new HttpError(404, `No workflow run "${runId}" was found.`);
    }
    res.status(200).json(serializeRun(run));
  };
}
