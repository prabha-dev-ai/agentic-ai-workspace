// The planner's output contract. Deliberately minimal: tool assignments,
// dependencies, and results belong to execution stories, not planning.
// Types are erased at runtime — planner.service.ts validates against them.

export interface PlanStep {
  id: number;
  description: string;
}

export interface ExecutionPlan {
  goal: string;
  steps: PlanStep[];
}
