import type OpenAI from 'openai';
import { getCurrentTime } from './time.tool.ts';

// The registry owns two views of every tool, and they must stay in sync:
// 1. toolDefinitions — the JSON Schema the MODEL sees (its "menu").
// 2. toolImplementations — the functions OUR CODE runs on the model's behalf.
// The LLM service only ever talks to the registry, so adding a tool means
// touching this file and nothing else.

export const toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description:
        'Returns the current local date and time, including the timezone. ' +
        'Use this whenever the user asks about the current time, date, or day.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

const toolImplementations: Record<string, () => string> = {
  get_current_time: getCurrentTime,
};

export function executeTool(name: string): string {
  const tool = toolImplementations[name];

  // Models can hallucinate tool names — never dispatch blindly.
  if (!tool) {
    throw new Error(`Model requested an unknown tool: "${name}"`);
  }

  return tool();
}
