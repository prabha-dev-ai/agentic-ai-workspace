// The plugin API surface. Plugins (and framework integration code) import
// from this barrel only — the individual files are implementation layout.

export type { AgentPlugin } from './AgentPlugin.ts';
export type { PluginContext } from './PluginContext.ts';
export type { PluginMetadata } from './PluginMetadata.ts';

export { PluginCapability } from './PluginCapability.ts';
export type {
  ToolContribution,
  ToolProvider,
  PromptContribution,
  PromptProvider,
  RetrieverContribution,
  RetrieverProvider,
  MemoryMessage,
  MemoryStore,
  MemoryProvider,
  EmbeddingContribution,
  EmbeddingProvider,
  VectorStoreDocument,
  VectorStoreSearchOptions,
  VectorStoreSearchResult,
  VectorStoreContribution,
  VectorStoreProvider,
  RankingCandidate,
  ScoredRankingCandidate,
  RankingStrategyContribution,
  RankingStrategyProvider,
  LogEntryContribution,
  LogSinkContribution,
  LogSinkProvider,
  SpanDataContribution,
  SpanExporterContribution,
  SpanExporterProvider,
  ServiceProvider,
  FrameworkEvent,
  EventSubscriber,
  WorkflowStep,
  WorkflowContribution,
  WorkflowProvider,
  AgentContribution,
  AgentProvider,
} from './PluginCapability.ts';

export { PluginRegistry } from './PluginRegistry.ts';
export { PluginLoader } from './PluginLoader.ts';
export { discoverPlugins, isAgentPlugin } from './PluginDiscovery.ts';
export type {
  PluginContributionSummary,
  PluginInstallation,
} from './PluginInstallation.ts';

export {
  PluginError,
  DuplicatePluginError,
  PluginNotFoundError,
  PluginValidationError,
} from './PluginErrors.ts';
