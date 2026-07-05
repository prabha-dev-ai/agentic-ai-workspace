import { randomUUID } from 'node:crypto';
import type { Agent } from './agent.types.ts';
import type {
  AgentRuntime,
  AgentRuntimeCreationOptions,
  AgentRuntimeFactory,
} from './agent.runtime.ts';

// Lifecycle management for live agents. The factory MINTS runtimes; this
// manager OWNS them: every spawned agent becomes a tracked session with
// a state machine (idle -> busy -> idle, or -> terminated) so the
// framework can answer "what is running?" and enforce safe usage.

export type AgentSessionStatus = 'idle' | 'busy' | 'terminated';

export interface AgentSession {
  readonly id: string;
  readonly agent: Agent;
  status: AgentSessionStatus;
  readonly createdAt: Date;
  lastActiveAt: Date | null;
  runCount: number;
}

export interface AgentLifecycleManager {
  /** Create and track a new live agent session. */
  spawn(agent: Agent, options?: AgentRuntimeCreationOptions): AgentSession;
  /** Run one message through a session, enforcing its state machine. */
  run(sessionId: string, message: string): Promise<string>;
  get(sessionId: string): AgentSession;
  list(): AgentSession[];
  /** End a session: memory cleared, further runs rejected. The record
   *  stays in list() as an audit trail. */
  terminate(sessionId: string): void;
  terminateAll(): void;
}

export function createAgentLifecycleManager(
  factory: AgentRuntimeFactory,
): AgentLifecycleManager {
  const sessions = new Map<
    string,
    { session: AgentSession; runtime: AgentRuntime }
  >();

  function requireSession(sessionId: string) {
    const entry = sessions.get(sessionId);

    if (!entry) {
      throw new Error(`Unknown agent session "${sessionId}".`);
    }

    return entry;
  }

  return {
    spawn(agent: Agent, options: AgentRuntimeCreationOptions = {}): AgentSession {
      const session: AgentSession = {
        id: randomUUID(),
        agent,
        status: 'idle',
        createdAt: new Date(),
        lastActiveAt: null,
        runCount: 0,
      };

      sessions.set(session.id, {
        session,
        runtime: factory.createRuntime(agent, options),
      });

      return session;
    },

    async run(sessionId: string, message: string): Promise<string> {
      const { session, runtime } = requireSession(sessionId);

      if (session.status === 'terminated') {
        throw new Error(`Agent session "${sessionId}" is terminated.`);
      }

      // One message at a time per session: a conversation processing two
      // messages concurrently would interleave its memory out of order.
      if (session.status === 'busy') {
        throw new Error(
          `Agent session "${sessionId}" is already processing a message.`,
        );
      }

      session.status = 'busy';

      try {
        const answer = await runtime.run(message);
        session.runCount++;
        return answer;
      } finally {
        // Only return to idle if nothing terminated us mid-run —
        // terminated must never resurrect.
        if (session.status === 'busy') {
          session.status = 'idle';
        }
        session.lastActiveAt = new Date();
      }
    },

    get(sessionId: string): AgentSession {
      return requireSession(sessionId).session;
    },

    list(): AgentSession[] {
      return [...sessions.values()].map((entry) => entry.session);
    },

    terminate(sessionId: string): void {
      const { session, runtime } = requireSession(sessionId);

      runtime.memory.clear();
      session.status = 'terminated';
    },

    terminateAll(): void {
      for (const { session, runtime } of sessions.values()) {
        if (session.status !== 'terminated') {
          runtime.memory.clear();
          session.status = 'terminated';
        }
      }
    },
  };
}
