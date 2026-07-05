import type OpenAI from 'openai';
import { env } from '../config/env.ts';
import { runAgentLoop } from '../agents/agent-loop.ts';
import { EXECUTOR_PROMPT } from '../prompts/executor.prompt.ts';
import type { ToolSource } from '../agents/agent-loop.ts';
import type { ExecutionPlan, PlanStep } from '../planner/planner.types.ts';
import type { ExecutionResult, StepResult } from './executor.types.ts';

// The executor coordinates; it never talks to the LLM directly. Each step
// becomes one full agent-loop run (which may use several tool iterations),
// and its output becomes context for the steps after it. The OpenAI
// client is injected (see core/bootstrap.ts).

export interface ExecutorService {
  executePlan(plan: ExecutionPlan): Promise<ExecutionResult>;
}

export function createExecutorService(
  client: OpenAI,
  tools: ToolSource,
): ExecutorService {
  return {
    async executePlan(plan: ExecutionPlan): Promise<ExecutionResult> {
      validatePlan(plan);

      const stepResults: StepResult[] = [];

      // Sequential on purpose: later steps consume earlier outputs, so
      // order is part of the contract.
      for (const step of plan.steps) {
        try {
          const output = await runAgentLoop({
            client,
            model: env.llm.model,
            messages: buildStepMessages(plan, step, stepResults),
            tools,
          });

          stepResults.push({ step, status: 'completed', output });
        } catch (error) {
          // A failed step is recorded, not thrown: later steps may not
          // depend on it, and a partial result beats none.
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
    },
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
