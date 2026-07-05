import OpenAI from 'openai';
import { env } from '../config/env.ts';

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

export async function generateResponse(message: string): Promise<string> {
  const completion = await client.chat.completions.create({
    model: env.llm.model,
    messages: [{ role: 'user', content: message }],
  });

  const content = completion.choices[0]?.message.content;

  // The API can return zero choices or null content (e.g. filtered output).
  // Failing loudly here beats letting "undefined" leak into a response.
  if (!content) {
    throw new Error('LLM returned an empty response.');
  }

  return content;
}
