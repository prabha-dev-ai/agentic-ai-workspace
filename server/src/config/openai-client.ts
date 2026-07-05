import OpenAI from 'openai';
import { env } from './env.ts';

// The single shared OpenAI client. llm.service, planner and executor still
// carry their own copies from earlier stories; new code uses this module,
// and the older services migrate here in a future cleanup story.
if (!env.llm.apiKey) {
  throw new Error(
    'LLM_API_KEY is not set. Add it to server/.env before starting the server.',
  );
}

export const openaiClient = new OpenAI({
  apiKey: env.llm.apiKey,
  baseURL: env.llm.baseUrl,
});
