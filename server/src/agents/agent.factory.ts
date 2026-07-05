import { env } from '../config/env.ts';
import type { Agent, AgentConfig } from './agent.types.ts';

// Turns caller configuration into a validated, fully resolved, immutable
// Agent. Validation lives here — at creation — so a broken definition
// fails at startup, not in the middle of a conversation.
export function createAgent(config: AgentConfig): Agent {
  if (config.name.trim() === '') {
    throw new Error('An agent needs a non-empty name.');
  }

  if (config.systemPrompt.trim() === '') {
    throw new Error(`Agent "${config.name}" needs a non-empty system prompt.`);
  }

  if (config.maxIterations !== undefined && config.maxIterations < 1) {
    throw new Error(
      `Agent "${config.name}" needs a maxIterations of at least 1.`,
    );
  }

  // Frozen so one definition can be shared by many runtimes without any
  // of them mutating the others' behavior.
  return Object.freeze({
    name: config.name,
    description: config.description,
    systemPrompt: config.systemPrompt,
    model: config.model ?? env.llm.model,
    maxIterations: config.maxIterations ?? 5,
  });
}
