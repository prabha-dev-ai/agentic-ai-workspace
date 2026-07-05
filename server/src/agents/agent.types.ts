// An agent is DATA: identity and behavior as configuration, executed by
// shared machinery (agent-loop, tool registry). Definitions are immutable
// and shareable; live state belongs to the runtime, never in here.

/** What callers provide. Optional fields fall back to environment defaults. */
export interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  maxIterations?: number;
}

/** A validated, fully resolved definition — produced by the factory. */
export interface Agent {
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  maxIterations: number;
}
