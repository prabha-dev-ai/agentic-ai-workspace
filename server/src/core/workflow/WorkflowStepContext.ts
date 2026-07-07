// What a step's execute()/next() sees: the run's original input, plus
// every prior step's output in this run, keyed by step id. The same
// object is threaded through every step in a run — each step sees the
// accumulated results of everything that ran before it.
export interface WorkflowStepContext {
  input: Record<string, unknown>;
  results: Record<string, unknown>;
}
