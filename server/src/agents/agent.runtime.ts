import type OpenAI from 'openai';
import { createConversationMemory } from '../memory/conversation-memory.ts';
import { buildContext, formatRetrievedKnowledge } from '../memory/context-manager.ts';
import { retrieveDocuments } from '../knowledge/retriever.service.ts';
import { RAG_INSTRUCTIONS } from '../prompts/rag.prompt.ts';
import { runAgentLoop } from './agent-loop.ts';
import { AgentState } from '../core/lifecycle/AgentState.ts';
import { LifecycleManager } from '../core/lifecycle/LifecycleManager.ts';
import type { ToolSource } from './agent-loop.ts';
import type { Agent } from './agent.types.ts';
import type { ConversationMemory } from '../memory/memory.types.ts';
import type { ContextWindow } from '../memory/context-manager.types.ts';
import type { KnowledgeStore } from '../knowledge/knowledge-store.ts';
import type { EventBus } from '../core/events/EventBus.ts';
import type { AgentRegistry } from '../core/agents/AgentRegistry.ts';

// The runtime binds an immutable Agent definition to live resources (the
// LLM client) and executes conversations with it. Definition = who the
// agent is; runtime = what it is doing right now. Keeping them separate
// is what lets one definition serve many concurrent conversations —
// including this file's conversation memory, which is why memory lives
// here and never on the shared definition.

export interface AgentRuntimeOptions {
  /** The LLM client — always injected, never constructed here. */
  client: OpenAI;
  /** The tool catalog (from the plugin loader) — always injected. */
  tools: ToolSource;
  /** When provided, lifecycle transitions publish framework events. */
  eventBus?: EventBus;
  /** When provided, the runtime registers its agent on creation. */
  agentRegistry?: AgentRegistry;
  /** Policy for what the model sees per turn. Default: sliding window of 10. */
  contextWindow?: ContextWindow;
  /** Optional knowledge base. When set, every turn retrieves against it. */
  knowledgeStore?: KnowledgeStore;
}

/** Options a caller may choose; the rest are the factory's job. */
export type AgentRuntimeCreationOptions = Omit<
  AgentRuntimeOptions,
  'client' | 'tools' | 'eventBus' | 'agentRegistry'
>;

// The container-facing entry point: binds the process-wide client and
// tool catalog once, so callers create runtimes without ever touching
// connection or plugin concerns.
export interface AgentRuntimeFactory {
  createRuntime(agent: Agent, options?: AgentRuntimeCreationOptions): AgentRuntime;
}

export function createAgentRuntimeFactory(
  client: OpenAI,
  tools: ToolSource,
  eventBus?: EventBus,
  agentRegistry?: AgentRegistry,
): AgentRuntimeFactory {
  return {
    createRuntime(agent: Agent, options: AgentRuntimeCreationOptions = {}) {
      return createAgentRuntime(agent, {
        ...options,
        client,
        tools,
        ...(eventBus !== undefined ? { eventBus } : {}),
        ...(agentRegistry !== undefined ? { agentRegistry } : {}),
      });
    },
  };
}

export interface AgentRuntime {
  agent: Agent;
  /** This runtime's short-term memory. clear() starts a new conversation. */
  memory: ConversationMemory;
  /** Diagnostics: one lifecycle per run(), with full transition history. */
  lifecycles: LifecycleManager;
  /** Run one turn with this agent and return its raw final answer. */
  run(message: string): Promise<string>;
}

export function createAgentRuntime(
  agent: Agent,
  options: AgentRuntimeOptions,
): AgentRuntime {
  const { client, tools } = options;
  const memory = createConversationMemory();

  // With a registry present, the agent registers itself and its lifecycle
  // events carry the registry id as source — that label is how the
  // registry tracks state from the bus without any direct calls.
  const registryHandle = options.agentRegistry?.register({
    name: agent.name,
    type: 'conversational',
    metadata: { description: agent.description, model: agent.model },
  });

  const lifecycles = new LifecycleManager({
    ...(options.eventBus !== undefined ? { eventBus: options.eventBus } : {}),
    source: `agent:${registryHandle?.id ?? agent.name}`,
  });
  const contextWindow: ContextWindow =
    options.contextWindow ?? { strategy: 'sliding-window', size: 10 };

  return {
    agent,
    memory,
    lifecycles,

    async run(message: string): Promise<string> {
      // Every execution gets its own lifecycle instance; the transitions
      // below are the formal record of what this run did and when.
      const lifecycle = lifecycles.create();

      try {
        // INITIALIZING: assemble everything the model will see.
        lifecycle.transition(AgentState.Initializing);

        // RAG happens BEFORE generation: search the knowledge base with
        // the user's message, and put the winners in front of the model.
        // Fresh every turn and never persisted to memory — injected
        // knowledge is working state, and re-remembering it would
        // fossilize stale docs into the conversation.
        const knowledgeBlock = options.knowledgeStore
          ? formatRetrievedKnowledge(
              retrieveDocuments(options.knowledgeStore, message),
            )
          : null;

        // One merged system message (free-tier models mishandle a second
        // one): agent identity, then RAG rules + retrieved documents.
        const systemContent = knowledgeBlock
          ? `${agent.systemPrompt}\n\n${RAG_INSTRUCTIONS}\n\n${knowledgeBlock}`
          : agent.systemPrompt;

        // Memory remembers everything; the context manager decides what
        // the model sees this turn: system prompt, the windowed history,
        // then the new user message.
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
          { role: 'system', content: systemContent },
          ...buildContext(memory.getHistory(), contextWindow),
          { role: 'user', content: message },
        ];

        lifecycle.transition(AgentState.Ready);
        lifecycle.transition(AgentState.Executing);

        const answer = await runAgentLoop({
          client,
          model: agent.model,
          messages,
          // Decorated so tool waits are visible in the lifecycle while
          // the loop itself stays completely lifecycle-unaware.
          tools: instrumentTools(tools, lifecycle),
          maxIterations: agent.maxIterations,
        });

        lifecycle.transition(AgentState.Completed);

        // Remember only successful exchanges — if the loop threw, the
        // model must not later "recall" a turn that never completed.
        // Tool calls from inside the loop are intentionally not persisted.
        memory.append({ role: 'user', content: message });
        memory.append({ role: 'assistant', content: answer });

        return answer;
      } catch (error) {
        if (!lifecycle.isTerminal()) {
          lifecycle.transition(
            AgentState.Failed,
            error instanceof Error ? error.message : String(error),
          );
        }
        throw error;
      }
    },
  };
}

// Wraps a ToolSource so every dispatch records Executing -> WaitingForTool
// -> Executing on the run's lifecycle. Failures propagate untouched; the
// run's catch block records them as the Failed transition.
function instrumentTools(
  tools: ToolSource,
  lifecycle: ReturnType<LifecycleManager['create']>,
): ToolSource {
  return {
    getToolDefinitions: () => tools.getToolDefinitions(),

    async executeTool(name, args) {
      lifecycle.transition(AgentState.WaitingForTool, `tool: ${name}`);
      try {
        return await tools.executeTool(name, args);
      } finally {
        if (!lifecycle.isTerminal()) {
          lifecycle.transition(AgentState.Executing);
        }
      }
    },
  };
}
