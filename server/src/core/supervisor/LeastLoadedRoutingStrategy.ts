import type { RoutingStrategy, WorkerCandidate } from './RoutingStrategy.ts';

// Route to whoever has the least on their plate. Ties break
// alphabetically by agent id — deterministic routing means the same
// inputs always produce the same choice, which makes orchestration
// reproducible and testable.
export class LeastLoadedRoutingStrategy implements RoutingStrategy {
  selectWorker(candidates: WorkerCandidate[]): string | null {
    const available = candidates.filter((candidate) => candidate.available);

    if (available.length === 0) {
      return null;
    }

    available.sort(
      (a, b) =>
        a.activeAssignments - b.activeAssignments ||
        a.agentId.localeCompare(b.agentId),
    );

    return available[0]?.agentId ?? null;
  }
}
