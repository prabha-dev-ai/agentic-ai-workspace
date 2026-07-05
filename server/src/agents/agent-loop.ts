import type OpenAI from 'openai';

// The Observe -> Think -> Act loop. Pure agent logic: no Express, no HTTP,
// no output parsing. Both the client AND the tools are injected — the
// loop has no opinion about where tools come from (in practice: the
// plugin loader aggregating every installed ToolProvider).

/** Where tools come from. The PluginLoader satisfies this structurally. */
export interface ToolSource {
  getToolDefinitions(): OpenAI.Chat.Completions.ChatCompletionTool[];
  executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> | string;
}

export interface AgentLoopOptions {
  client: OpenAI;
  model: string;
  /** Initial conversation (system + user). The loop appends to it. */
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  /** The tool catalog offered to the model on every iteration. */
  tools: ToolSource;
  /** Budget: hard cap on model calls so a looping agent fails loudly. */
  maxIterations?: number;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<string> {
  const { client, model, messages, tools, maxIterations = 5 } = options;

  const definitions = tools.getToolDefinitions();

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // THINK: the model reads the whole history and either answers or
    // requests tools. Some providers reject an empty tools array, so a
    // toolless agent simply offers none.
    const completion = await client.chat.completions.create({
      model,
      messages,
      ...(definitions.length > 0 ? { tools: definitions } : {}),
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

    // ACT: run each requested tool through the injected source. The
    // model's request goes into the history first, then one tool message
    // per call — paired by tool_call_id, or the API rejects the next turn.
    messages.push(reply);

    for (const toolCall of reply.tool_calls) {
      if (toolCall.type !== 'function') {
        continue;
      }

      // OBSERVE: the result becomes a message the next THINK will read.
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: await tools.executeTool(
          toolCall.function.name,
          parseToolArguments(toolCall.function.arguments),
        ),
      });
    }
  }

  throw new Error(
    `Agent loop exceeded ${maxIterations} iterations without a final answer.`,
  );
}

// The model sends arguments as a JSON string. Malformed JSON becomes {}
// rather than a crash — the tool itself decides how to handle absence.
function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
