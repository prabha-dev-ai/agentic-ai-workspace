import type OpenAI from 'openai';
import { env } from '../config/env.ts';
import { PLANNER_PROMPT } from '../prompts/planner.prompt.ts';
import type { ExecutionPlan, PlanStep } from './planner.types.ts';

// The planning role: decompose a request into steps, never execute them.
// The OpenAI client is injected (see core/bootstrap.ts).

export interface PlannerService {
  createPlan(message: string): Promise<ExecutionPlan>;
}

export function createPlannerService(client: OpenAI): PlannerService {
  return {
    async createPlan(message: string): Promise<ExecutionPlan> {
      const completion = await client.chat.completions.create({
        model: env.llm.model,
        messages: [
          { role: 'system', content: PLANNER_PROMPT },
          { role: 'user', content: message },
        ],
        // No tools are offered here, so JSON mode is safe to request.
        response_format: { type: 'json_object' },
      });

      const content = completion.choices[0]?.message.content;

      if (!content) {
        throw new Error('Planner returned an empty response.');
      }

      return parseExecutionPlan(content);
    },
  };
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
