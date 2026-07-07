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
  SpanExporterProvider: 'span-exporter-provider',
  MetricExporterProvider: 'metric-exporter-provider',
  CacheProvider: 'cache-provider',
  SecretProvider: 'secret-provider',
  StreamObserverProvider: 'stream-observer-provider',
  InteractionObserverProvider: 'interaction-observer-provider',
  WorkflowDefinitionProvider: 'workflow-definition-provider',
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

/** Mirrors core/tracing/Span.ts structurally — see module comment on
 *  self-contained contribution shapes. */
export interface SpanDataContribution {
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  name: string;
  component: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  status: 'unset' | 'ok' | 'error';
  attributes: Record<string, string | number | boolean>;
  error: string | undefined;
}

/** A named span destination (collector, file, tracing backend). */
export interface SpanExporterContribution {
  name: string;
  export(span: SpanDataContribution): void;
}

export interface SpanExporterProvider {
  getSpanExporters(): SpanExporterContribution[];
}

/** Mirrors core/metrics/MetricSnapshot.ts structurally — see module
 *  comment on self-contained contribution shapes. */
export interface MetricSampleContribution {
  labels: Record<string, string>;
  value: number;
}

export interface HistogramBucketContribution {
  le: number;
  count: number;
}

export interface HistogramSampleContribution {
  labels: Record<string, string>;
  count: number;
  sum: number;
  buckets: HistogramBucketContribution[];
}

export type MetricSnapshotContribution =
  | { type: 'counter'; name: string; help: string | undefined; samples: MetricSampleContribution[] }
  | { type: 'gauge'; name: string; help: string | undefined; samples: MetricSampleContribution[] }
  | { type: 'histogram'; name: string; help: string | undefined; samples: HistogramSampleContribution[] };

/** A named metrics destination (scrape endpoint, collector, dashboard backend). */
export interface MetricExporterContribution {
  name: string;
  export(snapshot: MetricSnapshotContribution[]): void;
}

export interface MetricExporterProvider {
  getMetricExporters(): MetricExporterContribution[];
}

/** Mirrors core/caching/Cache.ts structurally — see module comment on
 *  self-contained contribution shapes. */
export interface CacheStatsContribution {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  evictions: number;
  expirations: number;
  size: number;
}

/** A named cache backend (in-memory, Redis, a distributed cache). */
export interface CacheContribution {
  name: string;
  size: number;
  get(key: string): unknown;
  set(key: string, value: unknown, options?: { ttlMs?: number }): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  getStats(): CacheStatsContribution;
}

export interface CacheProvider {
  getCaches(): CacheContribution[];
}

/** Mirrors core/security/SecretSource.ts structurally — see module
 *  comment on self-contained contribution shapes. Returns a raw string,
 *  never the framework's Secret class: plugins should only ever need to
 *  import the plugin API (see PluginContext.ts), and Secret's private
 *  state can't cross that boundary anyway. */
export interface SecretSourceContribution {
  name: string;
  getSecret(name: string): string | undefined;
}

export interface SecretProvider {
  getSecretSources(): SecretSourceContribution[];
}

/** Mirrors core/streaming/StreamEvent.ts structurally — see module
 *  comment on self-contained contribution shapes. */
export type StreamEventContribution =
  | { type: 'chunk'; streamId: string; streamName: string; sequence: number; data: unknown; timestamp: Date }
  | { type: 'completed'; streamId: string; streamName: string; chunkCount: number; durationMs: number; timestamp: Date }
  | { type: 'error'; streamId: string; streamName: string; error: string; chunkCount: number; durationMs: number; timestamp: Date }
  | { type: 'cancelled'; streamId: string; streamName: string; chunkCount: number; durationMs: number; timestamp: Date };

/** A named global observer that watches every stream's events (a collector, a transport). */
export interface StreamObserverContribution {
  name: string;
  onEvent(event: StreamEventContribution): void;
}

export interface StreamObserverProvider {
  getStreamObservers(): StreamObserverContribution[];
}

/** Mirrors core/interaction/InteractionEvent.ts structurally — see module
 *  comment on self-contained contribution shapes. */
export type InteractionEventContribution =
  | {
      type: 'requested';
      interactionId: string;
      agentId: string | undefined;
      interactionType: 'approval' | 'input';
      prompt: string;
      timestamp: Date;
    }
  | {
      type: 'resolved';
      interactionId: string;
      response:
        | { type: 'approval'; approved: boolean; comment?: string }
        | { type: 'input'; value: string };
      timestamp: Date;
    }
  | { type: 'cancelled'; interactionId: string; timestamp: Date }
  | { type: 'timedout'; interactionId: string; timestamp: Date };

/** A named global observer that watches every human-in-the-loop interaction
 *  (an audit log, a chat transport relaying prompts to a human). */
export interface InteractionObserverContribution {
  name: string;
  onEvent(event: InteractionEventContribution): void;
}

export interface InteractionObserverProvider {
  getInteractionObservers(): InteractionObserverContribution[];
}

/**
 * Mirrors core/workflow/WorkflowDefinition.ts structurally — see module
 * comment on self-contained contribution shapes. Deliberately separate
 * from the pre-existing WorkflowProvider/WorkflowContribution above:
 * that capability is a purely descriptive catalog (numeric step ids, no
 * execution behavior) already shipped and consumed elsewhere, so it stays
 * untouched for backward compatibility. This capability is how plugins
 * contribute genuinely EXECUTABLE workflows to core/workflow's engine.
 */
export interface WorkflowStepContextContribution {
  input: Record<string, unknown>;
  results: Record<string, unknown>;
}

export interface WorkflowStepDefinitionContribution {
  id: string;
  name: string;
  execute(context: WorkflowStepContextContribution): Promise<unknown> | unknown;
  next?(context: WorkflowStepContextContribution, output: unknown): string | undefined;
}

export interface WorkflowDefinitionContribution {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStepDefinitionContribution[];
}

export interface WorkflowDefinitionProvider {
  getWorkflowDefinitions(): WorkflowDefinitionContribution[];
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
