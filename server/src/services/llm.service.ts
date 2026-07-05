import type OpenAI from 'openai';
import { env } from '../config/env.ts';
import { SYSTEM_PROMPT } from '../prompts/system.prompt.ts';
import { JSON_OUTPUT_INSTRUCTIONS } from '../prompts/json-output.prompt.ts';
import { runAgentLoop } from '../agents/agent-loop.ts';
import type { AIResponse } from '../types/ai-response.ts';

// The assistant's chat service. The OpenAI client is injected (see
// core/bootstrap.ts) — services never construct their own connections,
// so the whole process shares one client.

export interface LlmService {
  generateResponse(message: string): Promise<AIResponse>;
}

export function createLlmService(client: OpenAI): LlmService {
  return {
    async generateResponse(message: string): Promise<AIResponse> {
      // The service owns the conversation setup and the output contract.
      // The Observe -> Think -> Act cycle itself lives in the agent loop.
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        // One combined system message: many models (especially the free
        // ones behind the openrouter/free router) ignore or drop a second
        // system message, so behavior and format rules travel together.
        {
          role: 'system',
          content: `${SYSTEM_PROMPT}\n\n${JSON_OUTPUT_INSTRUCTIONS}`,
        },
        { role: 'user', content: message },
      ];

      const raw = await runAgentLoop({
        client,
        model: env.llm.model,
        messages,
        maxIterations: 5,
      });

      return parseAIResponse(raw);
    },
  };
}

// Never trust model output: JSON mode ensures valid JSON at best, not our
// shape. Validate at this boundary so everything downstream can rely on
// the AIResponse type.
function parseAIResponse(raw: string): AIResponse {
  // Some models wrap JSON in markdown fences despite instructions.
  // Tolerate the wrapper, but stay strict about the schema below.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');

  let data: unknown;

  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new Error(`LLM response is not valid JSON: ${raw.slice(0, 200)}`);
  }

  const answer = (data as { answer?: unknown }).answer;

  if (typeof answer !== 'string' || answer.trim() === '') {
    throw new Error(
      `LLM response is missing the "answer" field: ${raw.slice(0, 200)}`,
    );
  }

  return { answer };
}
