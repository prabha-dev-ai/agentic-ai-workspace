import type OpenAI from 'openai';
import { toolDefinitions, executeTool } from '../tools/tool-registry.ts';

// The Observe -> Think -> Act loop. Pure agent logic: no Express, no HTTP,
// no output parsing. The client is injected so the loop can be tested with
// a fake client and reused by future agents with different configurations.

export interface AgentLoopOptions {
  client: OpenAI;
  model: string;
  /** Initial conversation (system + user). The loop appends to it. */
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  /** Budget: hard cap on model calls so a looping agent fails loudly. */
  maxIterations?: number;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<string> {
  const { client, model, messages, maxIterations = 5 } = options;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // THINK: the model reads the whole history and either answers or
    // requests tools.
    const completion = await client.chat.completions.create({
      model,
      messages,
      tools: toolDefinitions,
    });

    const reply = completion.choices[0]?.message;

    if (!reply) {
      throw new Error('LLM returned an empty response.');
    }

    // No tool requests means the model produced its final answer.
    if (!reply.tool_calls || reply.tool_calls.length === 0) {
      if (!reply.content) {
        throw new Error('LLM returned an empty response.');
      }
      return reply.content;
    }

    // ACT: run each requested tool through the registry. The model's
    // request goes into the history first, then one tool message per
    // call — paired by tool_call_id, or the API rejects the next turn.
    messages.push(reply);

    for (const toolCall of reply.tool_calls) {
      if (toolCall.type !== 'function') {
        continue;
      }

      // OBSERVE: the result becomes a message the next THINK will read.
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: executeTool(toolCall.function.name),
      });
    }
  }

  throw new Error(
    `Agent loop exceeded ${maxIterations} iterations without a final answer.`,
  );
}
