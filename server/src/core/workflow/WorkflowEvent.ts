// What a run emits, as a discriminated union — same rationale as
// StreamEvent/InteractionEvent: a consumer switching on `type` gets
// exactly the fields that moment carries.
export type WorkflowEvent =
  | {
      type: 'started';
      runId: string;
      definitionId: string;
      definitionName: string;
      timestamp: Date;
    }
  | { type: 'step-started'; runId: string; stepId: string; timestamp: Date }
  | { type: 'step-completed'; runId: string; stepId: string; output: unknown; timestamp: Date }
  | { type: 'step-failed'; runId: string; stepId: string; error: string; timestamp: Date }
  | { type: 'completed'; runId: string; durationMs: number; timestamp: Date }
  | { type: 'failed'; runId: string; error: string; durationMs: number; timestamp: Date };
