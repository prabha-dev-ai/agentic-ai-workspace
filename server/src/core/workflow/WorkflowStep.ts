import type { WorkflowStepContext } from './WorkflowStepContext.ts';

// One executable unit of a workflow. Sequential by default: with no
// next(), the runtime moves to whatever step follows it in the
// definition's array order. Providing next() is the entire mechanism
// behind conditional branching — it inspects the context/output and
// returns the id of whichever step should run next, or undefined to end
// the workflow right there.
export interface WorkflowStep {
  id: string;
  name: string;

  /** Do the step's work. Its return value becomes context.results[id] for every later step. */
  execute(context: WorkflowStepContext): Promise<unknown> | unknown;

  /** Decide the next step. Omit for sequential order; return undefined to stop here. */
  next?(context: WorkflowStepContext, output: unknown): string | undefined;
}

export interface WorkflowStepResult {
  stepId: string;
  status: 'completed' | 'failed';
  output: unknown;
  error: string | undefined;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
}
