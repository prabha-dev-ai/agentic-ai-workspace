import OpenAI from 'openai';
import { env } from '../config/env.ts';
import { runAgentLoop } from '../agents/agent-loop.ts';
import { EXECUTOR_PROMPT } from '../prompts/executor.prompt.ts';
import type { ExecutionPlan, PlanStep } from '../planner/planner.types.ts';
import type { ExecutionResult, StepResult } from './executor.types.ts';

// The executor coordinates; it never talks to the LLM directly. Each step
// becomes one full agent-loop run (which may use several tool iterations),
// and its output becomes context for the steps after it.

if (!env.llm.apiKey) {
  throw new Error(
    'LLM_API_KEY is not set. Add it to server/.env before starting the server.',
  );
}

const defaultClient = new OpenAI({
  apiKey: env.llm.apiKey,
  baseURL: env.llm.baseUrl,
});

export interface ExecutorOptions {
  /** Injectable for tests and future per-agent configuration. */
  client?: OpenAI;
  model?: string;
}

export async function executePlan(
  plan: ExecutionPlan,
  options: ExecutorOptions = {},
): Promise<ExecutionResult> {
  validatePlan(plan);

  const client = options.client ?? defaultClient;
  const model = options.model ?? env.llm.model;

  const stepResults: StepResult[] = [];

  // Sequential on purpose: later steps consume earlier outputs, so order
  // is part of the contract. Parallelism belongs to a future story.
  for (const step of plan.steps) {
    try {
      const output = await runAgentLoop({
        client,
        model,
        messages: buildStepMessages(plan, step, stepResults),
      });

      stepResults.push({ step, status: 'completed', output });
    } catch (error) {
      // A failed step is recorded, not thrown: later steps may not depend
      // on it, and a partial result beats none. The caller sees the counts.
      stepResults.push({
        step,
        status: 'failed',
        output: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const completedSteps = stepResults.filter(
    (result) => result.status === 'completed',
  ).length;

  return {
    goal: plan.goal,
    stepResults,
    completedSteps,
    failedSteps: stepResults.length - completedSteps,
  };
}

// Plans will not always come from our planner (storage, APIs), so the
// executor guards its own input instead of trusting the type.
function validatePlan(plan: ExecutionPlan): void {
  if (typeof plan.goal !== 'string' || plan.goal.trim() === '') {
    throw new Error('Cannot execute a plan without a goal.');
  }

  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error('Cannot execute a plan with no steps.');
  }

  for (const step of plan.steps) {
    if (typeof step.description !== 'string' || step.description.trim() === '') {
      throw new Error(`Plan step ${step.id} has no description.`);
    }
  }
}

// Each step gets a fresh, scoped conversation: the goal, everything the
// previous steps produced, and the single instruction to execute now.
// Passing previous results forward is what turns N isolated questions
// into a pipeline.
function buildStepMessages(
  plan: ExecutionPlan,
  step: PlanStep,
  previousResults: StepResult[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const previousContext =
    previousResults.length === 0
      ? 'No steps have been executed yet.'
      : previousResults
          .map(
            (result) =>
              `Step ${result.step.id} (${result.status}): ${result.output}`,
          )
          .join('\n');

  return [
    { role: 'system', content: EXECUTOR_PROMPT },
    {
      role: 'user',
      content: [
        `Overall goal: ${plan.goal}`,
        '',
        'Results of previous steps:',
        previousContext,
        '',
        `Execute this step now — Step ${step.id}: ${step.description}`,
      ].join('\n'),
    },
  ];
}
