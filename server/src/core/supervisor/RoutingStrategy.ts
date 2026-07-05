// How a supervisor picks a worker. A strategy interface so smarter
// routing (priority, capability matching, LLM-based) can drop in without
// touching the supervisor.

export interface WorkerCandidate {
  agentId: string;
  /** Derived from registry state: failed/cancelled agents are not available. */
  available: boolean;
  /** Live task count from the delegation manager. */
  activeAssignments: number;
}

export interface RoutingStrategy {
  /** Pick a worker id, or null when no candidate qualifies. */
  selectWorker(candidates: WorkerCandidate[]): string | null;
}
