import type { WorkflowStep } from './WorkflowStep.ts';

// The workflow model: a named, ordered set of steps. Static shape only —
// running it (WorkflowRuntime.run) is what produces a WorkflowRun.
export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
}
