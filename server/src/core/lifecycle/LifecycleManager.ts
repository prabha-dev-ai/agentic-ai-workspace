import { randomUUID } from 'node:crypto';
import { AgentLifecycle } from './AgentLifecycle.ts';

// Creates and tracks lifecycle instances — the diagnostics surface for
// "what executions happened, and what state is each in?". One manager
// per runtime keeps diagnostics scoped to their conversation.
export class LifecycleManager {
  private readonly lifecycles = new Map<string, AgentLifecycle>();

  create(): AgentLifecycle {
    const lifecycle = new AgentLifecycle(randomUUID());
    this.lifecycles.set(lifecycle.id, lifecycle);
    return lifecycle;
  }

  get(id: string): AgentLifecycle {
    const lifecycle = this.lifecycles.get(id);

    if (!lifecycle) {
      throw new Error(`Unknown lifecycle "${id}".`);
    }

    return lifecycle;
  }

  /** Every execution's lifecycle, in creation order. */
  list(): AgentLifecycle[] {
    return [...this.lifecycles.values()];
  }
}
