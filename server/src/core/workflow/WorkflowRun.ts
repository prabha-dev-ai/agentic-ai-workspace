import type { WorkflowStatus } from './WorkflowStatus.ts';
import type { WorkflowStepResult } from './WorkflowStep.ts';

// One execution of a WorkflowDefinition: the run's outcome, every step's
// individual result in the order it ran, and the accumulated results a
// later re-read would see. Returned by WorkflowRuntime.run() once the
// run reaches a terminal state — there is no in-flight handle, unlike
// Stream/Interaction, because a run is driven entirely by the runtime's
// own execution loop rather than pushed to by an external producer.
export interface WorkflowRun {
  readonly id: string;
  readonly definitionId: string;
  readonly definitionName: string;
  readonly status: WorkflowStatus;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly durationMs: number;
  readonly input: Record<string, unknown>;
  readonly results: Record<string, unknown>;
  readonly steps: WorkflowStepResult[];
  readonly error: string | undefined;
}
