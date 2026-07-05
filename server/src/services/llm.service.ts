import OpenAI from 'openai';
import { env } from '../config/env.ts';
import { SYSTEM_PROMPT } from '../prompts/system.prompt.ts';
import { JSON_OUTPUT_INSTRUCTIONS } from '../prompts/json-output.prompt.ts';
import { runAgentLoop } from '../agents/agent-loop.ts';
import type { AIResponse } from '../types/ai-response.ts';

// OpenRouter implements the OpenAI API, so the official SDK works with it —
// only the baseURL changes. Swapping providers is a config change, not code.
if (!env.llm.apiKey) {
  throw new Error(
    'LLM_API_KEY is not set. Add it to server/.env before starting the server.',
  );
}

// One client for the whole process: it is a stateless HTTP wrapper, so
// creating it per request would only waste connections.
const client = new OpenAI({
  apiKey: env.llm.apiKey,
  baseURL: env.llm.baseUrl,
});

export async function generateResponse(message: string): Promise<AIResponse> {
  // The service owns the conversation setup and the output contract.
  // The Observe -> Think -> Act cycle itself lives in the agent loop.
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    // One combined system message: many models (especially the free
    // ones behind the openrouter/free router) ignore or drop a second
    // system message, so behavior and format rules travel together.
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${JSON_OUTPUT_INSTRUCTIONS}` },
    { role: 'user', content: message },
  ];

  const raw = await runAgentLoop({
    client,
    model: env.llm.model,
    messages,
    maxIterations: 5,
  });

  return parseAIResponse(raw);
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
