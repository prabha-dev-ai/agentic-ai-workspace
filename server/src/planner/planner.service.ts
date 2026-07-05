import OpenAI from 'openai';
import { env } from '../config/env.ts';
import { PLANNER_PROMPT } from '../prompts/planner.prompt.ts';
import type { ExecutionPlan, PlanStep } from './planner.types.ts';

// Structured like llm.service.ts on purpose: env-based client, one public
// function, strict parse-then-validate at the boundary. The second client
// instance duplicates llm.service.ts because modifying it is out of scope
// here — a shared config/openai-client.ts is the future consolidation.
if (!env.llm.apiKey) {
  throw new Error(
    'LLM_API_KEY is not set. Add it to server/.env before starting the server.',
  );
}

const client = new OpenAI({
  apiKey: env.llm.apiKey,
  baseURL: env.llm.baseUrl,
});

export async function createPlan(message: string): Promise<ExecutionPlan> {
  const completion = await client.chat.completions.create({
    model: env.llm.model,
    messages: [
      { role: 'system', content: PLANNER_PROMPT },
      { role: 'user', content: message },
    ],
    // No tools are offered here, so JSON mode is safe to request directly.
    response_format: { type: 'json_object' },
  });

  const content = completion.choices[0]?.message.content;

  if (!content) {
    throw new Error('Planner returned an empty response.');
  }

  return parseExecutionPlan(content);
}

// Types are erased at runtime, so the plan must be validated field by
// field. Each check throws its own error: when planning fails, WHY it
// failed is what we need in the logs.
function parseExecutionPlan(raw: string): ExecutionPlan {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');

  let data: unknown;

  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new Error(`Planner response is not valid JSON: ${raw.slice(0, 200)}`);
  }

  const { goal, steps } = data as { goal?: unknown; steps?: unknown };

  if (typeof goal !== 'string' || goal.trim() === '') {
    throw new Error(
      `Planner response is missing the "goal" field: ${raw.slice(0, 200)}`,
    );
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(
      `Planner response has no "steps" array: ${raw.slice(0, 200)}`,
    );
  }

  const validatedSteps: PlanStep[] = steps.map((step: unknown, index) => {
    const { id, description } = (step ?? {}) as {
      id?: unknown;
      description?: unknown;
    };

    if (typeof id !== 'number') {
      throw new Error(`Plan step ${index + 1} is missing a numeric "id".`);
    }

    if (typeof description !== 'string' || description.trim() === '') {
      throw new Error(`Plan step ${index + 1} is missing a "description".`);
    }

    return { id, description };
  });

  return { goal, steps: validatedSteps };
}
