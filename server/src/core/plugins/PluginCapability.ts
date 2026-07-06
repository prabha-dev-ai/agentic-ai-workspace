import type OpenAI from 'openai';
import type { ServiceCollection } from '../container/ServiceCollection.ts';

// The capability model. Each capability is two halves of one contract:
// the identifier a plugin DECLARES in its metadata, and the provider
// interface it IMPLEMENTS to back that claim. Integration stories consume
// providers; this story only defines them.
//
// Contribution shapes are defined HERE, structurally, rather than by
// importing domain modules: a plugin should only ever need to import the
// plugin API. TypeScript's structural typing keeps these interoperable
// with the domain types they mirror.
//
// A const-object union instead of a TS enum: Node's type stripping
// cannot run enums.
export const PluginCapability = {
  ToolProvider: 'tool-provider',
  PromptProvider: 'prompt-provider',
  RetrieverProvider: 'retriever-provider',
  MemoryProvider: 'memory-provider',
  ServiceProvider: 'service-provider',
  EventSubscriber: 'event-subscriber',
  WorkflowProvider: 'workflow-provider',
  AgentProvider: 'agent-provider',
  EmbeddingProvider: 'embedding-provider',
  VectorStoreProvider: 'vector-store-provider',
  RankingStrategyProvider: 'ranking-strategy-provider',
  LogSinkProvider: 'log-sink-provider',
} as const;

export type PluginCapability =
  (typeof PluginCapability)[keyof typeof PluginCapability];

/** A tool contribution: the model-facing definition + our-side executor. */
export interface ToolContribution {
  definition: OpenAI.Chat.Completions.ChatCompletionTool;
  execute(args: Record<string, unknown>): Promise<string> | string;
}

export interface ToolProvider {
  getTools(): ToolContribution[];
}

/** A named prompt fragment a plugin contributes (e.g. persona, rules). */
export interface PromptContribution {
  name: string;
  content: string;
}

export interface PromptProvider {
  getPrompts(): PromptContribution[];
}

/** A named retriever: query in, ranked context strings out. */
export interface RetrieverContribution {
  name: string;
  retrieve(query: string): Promise<string[]> | string[];
}

export interface RetrieverProvider {
  getRetrievers(): RetrieverContribution[];
}

/** Mirrors memory/memory.types.ts structurally — see module comment. */
export interface MemoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface MemoryStore {
  append(message: MemoryMessage): void;
  getHistory(): MemoryMessage[];
  clear(): void;
}

/** Alternative conversation-memory backends (e.g. persistent stores). */
export interface MemoryProvider {
  createMemoryStore(): MemoryStore;
}

/** Plugins may register services into the container at composition time. */
export interface ServiceProvider {
  registerServices(services: ServiceCollection): void;
}

/** Framework lifecycle/domain events. The event bus arrives later. */
export interface FrameworkEvent {
  type: string;
  payload?: unknown;
}

export interface EventSubscriber {
  onEvent(event: FrameworkEvent): void | Promise<void>;
}

/** A reusable multi-step routine — mirrors planner step shape. */
export interface WorkflowStep {
  id: number;
  description: string;
}

export interface WorkflowContribution {
  name: string;
  description: string;
  steps: WorkflowStep[];
}

export interface WorkflowProvider {
  getWorkflows(): WorkflowContribution[];
}

/** Mirrors core/embeddings/EmbeddingProvider structurally — see module
 *  comment on self-contained contribution shapes. */
export interface EmbeddingContribution {
  model: { name: string; dimensions?: number };
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

/** Alternative embedding backends (local models, other APIs). */
export interface EmbeddingProvider {
  getEmbeddingProvider(): EmbeddingContribution;
}

/** Mirrors core/vectorstore types structurally — see module comment on
 *  self-contained contribution shapes. */
export interface VectorStoreDocument {
  id: string;
  text: string;
  vector: number[];
  metadata?: Record<string, string | number | boolean>;
}

export interface VectorStoreSearchOptions {
  topK?: number;
  metric?: 'cosine' | 'dot-product' | 'euclidean';
  filter?: Record<string, string | number | boolean>;
}

export interface VectorStoreSearchResult {
  document: VectorStoreDocument;
  score: number;
}

export interface VectorStoreContribution {
  add(document: VectorStoreDocument): Promise<void>;
  addBatch(documents: VectorStoreDocument[]): Promise<void>;
  update(document: VectorStoreDocument): Promise<void>;
  delete(id: string): Promise<void>;
  get(id: string): Promise<VectorStoreDocument | undefined>;
  search(
    vector: number[],
    options?: VectorStoreSearchOptions,
  ): Promise<VectorStoreSearchResult[]>;
  clear(): Promise<void>;
}

/** Alternative vector store backends (databases, remote indexes). */
export interface VectorStoreProvider {
  getVectorStore(): VectorStoreContribution;
}

/** Mirrors knowledge/knowledge-ranker.ts structurally — see module
 *  comment on self-contained contribution shapes. */
export interface RankingCandidate {
  id: string;
  text: string;
  title?: string;
  signals: Record<string, number>;
}

export interface ScoredRankingCandidate {
  candidate: RankingCandidate;
  score: number;
  explanation: {
    strategy: string;
    contributions: {
      signal: string;
      value: number;
      weight: number;
      contribution: number;
    }[];
    summary: string;
  };
}

/** A named ranking strategy: scores candidates, the ranker orders them. */
export interface RankingStrategyContribution {
  name: string;
  score(
    query: string,
    candidates: RankingCandidate[],
  ): ScoredRankingCandidate[] | Promise<ScoredRankingCandidate[]>;
}

export interface RankingStrategyProvider {
  getRankingStrategies(): RankingStrategyContribution[];
}

/** Mirrors core/observability/LogEntry.ts structurally — see module
 *  comment on self-contained contribution shapes. */
export interface LogEntryContribution {
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string;
  message: string;
  correlationId?: string;
  fields?: Record<string, unknown>;
}

/** A named log destination (file, remote collector, alerting). */
export interface LogSinkContribution {
  name: string;
  write(entry: LogEntryContribution): void;
}

export interface LogSinkProvider {
  getLogSinks(): LogSinkContribution[];
}

/** A contributed agent definition — mirrors agents/agent.types.ts. */
export interface AgentContribution {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  maxIterations?: number;
}

export interface AgentProvider {
  getAgents(): AgentContribution[];
}
