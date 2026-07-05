import type OpenAI from 'openai';
import { openaiClient } from '../config/openai-client.ts';
import { createConversationMemory } from '../memory/conversation-memory.ts';
import { buildContext, formatRetrievedKnowledge } from '../memory/context-manager.ts';
import { retrieveDocuments } from '../knowledge/retriever.service.ts';
import { RAG_INSTRUCTIONS } from '../prompts/rag.prompt.ts';
import { runAgentLoop } from './agent-loop.ts';
import type { Agent } from './agent.types.ts';
import type { ConversationMemory } from '../memory/memory.types.ts';
import type { ContextWindow } from '../memory/context-manager.types.ts';
import type { KnowledgeStore } from '../knowledge/knowledge-store.ts';

// The runtime binds an immutable Agent definition to live resources (the
// LLM client) and executes conversations with it. Definition = who the
// agent is; runtime = what it is doing right now. Keeping them separate
// is what lets one definition serve many concurrent conversations —
// including this file's conversation memory, which is why memory lives
// here and never on the shared definition.

export interface AgentRuntimeOptions {
  /** Injectable for tests and future per-agent providers. */
  client?: OpenAI;
  /** Policy for what the model sees per turn. Default: sliding window of 10. */
  contextWindow?: ContextWindow;
  /** Optional knowledge base. When set, every turn retrieves against it. */
  knowledgeStore?: KnowledgeStore;
}

export interface AgentRuntime {
  agent: Agent;
  /** This runtime's short-term memory. clear() starts a new conversation. */
  memory: ConversationMemory;
  /** Run one turn with this agent and return its raw final answer. */
  run(message: string): Promise<string>;
}

export function createAgentRuntime(
  agent: Agent,
  options: AgentRuntimeOptions = {},
): AgentRuntime {
  const client = options.client ?? openaiClient;
  const memory = createConversationMemory();
  const contextWindow: ContextWindow =
    options.contextWindow ?? { strategy: 'sliding-window', size: 10 };

  return {
    agent,
    memory,

    async run(message: string): Promise<string> {
      // RAG happens BEFORE generation: search the knowledge base with the
      // user's message, and put the winners in front of the model. Fresh
      // every turn and never persisted to memory — injected knowledge is
      // working state, and re-remembering it would fossilize stale docs
      // into the conversation.
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

      // Memory remembers everything; the context manager decides what the
      // model sees this turn: system prompt, the windowed history, then
      // the new user message.
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemContent },
        ...buildContext(memory.getHistory(), contextWindow),
        { role: 'user', content: message },
      ];

      const answer = await runAgentLoop({
        client,
        model: agent.model,
        messages,
        maxIterations: agent.maxIterations,
      });

      // Remember only successful exchanges — if the loop threw, the model
      // must not later "recall" a turn that never completed. Tool calls
      // from inside the loop are intentionally not persisted.
      memory.append({ role: 'user', content: message });
      memory.append({ role: 'assistant', content: answer });

      return answer;
    },
  };
}
