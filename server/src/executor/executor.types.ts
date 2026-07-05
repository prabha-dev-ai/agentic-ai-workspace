import type { PlanStep } from '../planner/planner.types.ts';

// Execution outcomes. A failed step is data, not an exception: execution
// continues, and the caller inspects the counts to judge overall success.

export interface StepResult {
  step: PlanStep;
  status: 'completed' | 'failed';
  /** The agent's answer for the step, or the error message if it failed. */
  output: string;
}

export interface ExecutionResult {
  goal: string;
  stepResults: StepResult[];
  completedSteps: number;
  failedSteps: number;
}
