import { PluginCapability } from './PluginCapability.ts';
import {
  PluginError,
  PluginNotFoundError,
  PluginValidationError,
} from './PluginErrors.ts';
import type OpenAI from 'openai';
import type { AgentPlugin } from './AgentPlugin.ts';
import type { PluginContext } from './PluginContext.ts';
import { EventType } from '../events/EventType.ts';
import type { PluginRegistry } from './PluginRegistry.ts';
import type {
  PluginContributionSummary,
  PluginInstallation,
} from './PluginInstallation.ts';
import type { EventBus } from '../events/EventBus.ts';
import type { EventHandler } from '../events/EventHandler.ts';
import type { ServiceCollection } from '../container/ServiceCollection.ts';
import type { Logger } from '../observability/Logger.ts';
import type {
  AgentContribution,
  AgentProvider,
  EmbeddingContribution,
  EmbeddingProvider,
  EventSubscriber,
  LogSinkContribution,
  LogSinkProvider,
  MemoryProvider,
  PromptContribution,
  PromptProvider,
  RankingStrategyContribution,
  RankingStrategyProvider,
  CacheContribution,
  CacheProvider,
  MetricExporterContribution,
  MetricExporterProvider,
  RetrieverContribution,
  RetrieverProvider,
  SpanExporterContribution,
  SpanExporterProvider,
  ToolContribution,
  ToolProvider,
  VectorStoreContribution,
  VectorStoreProvider,
  WorkflowContribution,
  WorkflowProvider,
} from './PluginCapability.ts';

// Every capability maps to the method that backs it. Declaring a
// capability without implementing its method fails installation —
// uniformly, for every capability.
const CAPABILITY_METHODS: Record<PluginCapability, string> = {
  [PluginCapability.ToolProvider]: 'getTools',
  [PluginCapability.PromptProvider]: 'getPrompts',
  [PluginCapability.RetrieverProvider]: 'getRetrievers',
  [PluginCapability.MemoryProvider]: 'createMemoryStore',
  [PluginCapability.ServiceProvider]: 'registerServices',
  [PluginCapability.EventSubscriber]: 'onEvent',
  [PluginCapability.WorkflowProvider]: 'getWorkflows',
  [PluginCapability.AgentProvider]: 'getAgents',
  [PluginCapability.EmbeddingProvider]: 'getEmbeddingProvider',
  [PluginCapability.VectorStoreProvider]: 'getVectorStore',
  [PluginCapability.RankingStrategyProvider]: 'getRankingStrategies',
  [PluginCapability.LogSinkProvider]: 'getLogSinks',
  [PluginCapability.SpanExporterProvider]: 'getSpanExporters',
  [PluginCapability.MetricExporterProvider]: 'getMetricExporters',
  [PluginCapability.CacheProvider]: 'getCaches',
};

/** A harvested contribution, tagged with the plugin that owns it. */
interface Owned<T> {
  value: T;
  pluginId: string;
}

// The lifecycle owner. The registry is passive bookkeeping; the loader
// installs plugins (validate -> catalog -> run register() hook -> harvest
// contributions) and uninstalls them (dispose() -> release everything).
// Installation is atomic: any failure rolls the plugin back completely.
export class PluginLoader {
  private readonly registry: PluginRegistry;

  // Named contribution catalogs. Names are unique across ALL plugins;
  // collisions fail the incoming install and report both owners.
  private readonly tools = new Map<string, Owned<ToolContribution>>();
  private readonly prompts = new Map<string, Owned<PromptContribution>>();
  private readonly retrievers = new Map<string, Owned<RetrieverContribution>>();
  private readonly workflows = new Map<string, Owned<WorkflowContribution>>();
  private readonly agents = new Map<string, Owned<AgentContribution>>();
  private readonly rankingStrategies = new Map<string, Owned<RankingStrategyContribution>>();
  private readonly logSinks = new Map<string, Owned<LogSinkContribution>>();
  private readonly spanExporters = new Map<string, Owned<SpanExporterContribution>>();
  private readonly metricExporters = new Map<string, Owned<MetricExporterContribution>>();
  private readonly caches = new Map<string, Owned<CacheContribution>>();

  // Unnamed contributions, keyed by owning plugin.
  private readonly memoryProviders = new Map<string, MemoryProvider>();
  private readonly eventSubscribers = new Map<string, EventSubscriber>();
  private readonly serviceProviders = new Map<string, ServiceProviderLike>();
  private readonly embeddingProviders = new Map<string, EmbeddingContribution>();
  private readonly vectorStores = new Map<string, VectorStoreContribution>();

  // Diagnostics: what each installed plugin contributed, and when.
  private readonly installations = new Map<string, PluginInstallation>();

  // EventSubscriber plugins wired onto the bus, so uninstall can unwire.
  private readonly busSubscriptions = new Map<string, EventHandler>();

  private readonly eventBus: EventBus | undefined;

  // Component-aware plugin logging: when a logger is provided, every
  // plugin's context.log() becomes a structured entry under
  // '<logger component>.<plugin id>'. Without one, the console fallback
  // keeps old embedders working unchanged.
  private readonly logger: Logger | undefined;

  constructor(registry: PluginRegistry, eventBus?: EventBus, logger?: Logger) {
    this.registry = registry;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  async install(plugin: AgentPlugin): Promise<void> {
    // Catalog first: metadata validation and duplicate-id rejection.
    this.registry.register(plugin);

    try {
      validateDeclaredCapabilities(plugin);
      await plugin.register(this.createContext(plugin));

      this.installations.set(plugin.metadata.id, {
        pluginId: plugin.metadata.id,
        installedAt: new Date(),
        contributions: this.harvest(plugin),
      });
    } catch (error) {
      // Atomic install: a plugin that failed half-way is not installed.
      this.registry.unregister(plugin.metadata.id);
      this.release(plugin.metadata.id);
      throw error;
    }

    this.eventBus?.publish({
      type: EventType.PluginInstalled,
      source: 'plugin-loader',
      correlationId: plugin.metadata.id,
      payload: {
        pluginId: plugin.metadata.id,
        name: plugin.metadata.name,
        version: plugin.metadata.version,
      },
    });
  }

  async uninstall(id: string): Promise<void> {
    const plugin = this.registry.get(id);

    await plugin.dispose?.();
    this.release(id);
    this.registry.unregister(id);

    this.eventBus?.publish({
      type: EventType.PluginUninstalled,
      source: 'plugin-loader',
      correlationId: id,
      payload: { pluginId: id },
    });
  }

  // ---- Contribution access ------------------------------------------

  /** Every installed tool definition — the model-facing menu. */
  getToolDefinitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return [...this.tools.values()].map((entry) => entry.value.definition);
  }

  /** Dispatch a model-requested tool call to the owning plugin. */
  async executeTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<string> {
    const entry = this.tools.get(name);

    // Models can hallucinate tool names — never dispatch blindly.
    if (!entry) {
      throw new Error(`No installed plugin provides a tool named "${name}".`);
    }

    return entry.value.execute(args);
  }

  getPrompts(): PromptContribution[] {
    return [...this.prompts.values()].map((entry) => entry.value);
  }

  getRetrievers(): RetrieverContribution[] {
    return [...this.retrievers.values()].map((entry) => entry.value);
  }

  getWorkflows(): WorkflowContribution[] {
    return [...this.workflows.values()].map((entry) => entry.value);
  }

  getAgents(): AgentContribution[] {
    return [...this.agents.values()].map((entry) => entry.value);
  }

  getMemoryProviders(): MemoryProvider[] {
    return [...this.memoryProviders.values()];
  }

  getEmbeddingProviders(): EmbeddingContribution[] {
    return [...this.embeddingProviders.values()];
  }

  getVectorStores(): VectorStoreContribution[] {
    return [...this.vectorStores.values()];
  }

  getRankingStrategies(): RankingStrategyContribution[] {
    return [...this.rankingStrategies.values()].map((entry) => entry.value);
  }

  getLogSinks(): LogSinkContribution[] {
    return [...this.logSinks.values()].map((entry) => entry.value);
  }

  getSpanExporters(): SpanExporterContribution[] {
    return [...this.spanExporters.values()].map((entry) => entry.value);
  }

  getMetricExporters(): MetricExporterContribution[] {
    return [...this.metricExporters.values()].map((entry) => entry.value);
  }

  getCaches(): CacheContribution[] {
    return [...this.caches.values()].map((entry) => entry.value);
  }

  /** Diagnostics: what a specific installed plugin contributed. */
  getInstallation(pluginId: string): PluginInstallation {
    const installation = this.installations.get(pluginId);

    if (!installation) {
      throw new PluginNotFoundError(pluginId);
    }

    return installation;
  }

  /** Diagnostics: every installation, in install order. */
  listInstallations(): PluginInstallation[] {
    return [...this.installations.values()];
  }

  getEventSubscribers(): EventSubscriber[] {
    return [...this.eventSubscribers.values()];
  }

  /**
   * Give every ServiceProvider plugin the chance to register services.
   * Called by bootstrap AFTER core registrations and BEFORE build(), so
   * plugin services live in the same container — and the collection's
   * duplicate protection guards against collisions with core tokens.
   */
  registerServices(services: ServiceCollection): void {
    for (const [pluginId, provider] of this.serviceProviders) {
      try {
        provider.registerServices(services);
      } catch (error) {
        throw new PluginError(
          pluginId,
          `Plugin "${pluginId}" failed to register services: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  // ---- Harvesting ----------------------------------------------------

  private harvest(plugin: AgentPlugin): PluginContributionSummary {
    const { id, capabilities } = plugin.metadata;
    const has = (capability: PluginCapability) =>
      capabilities.includes(capability);

    const summary: PluginContributionSummary = {
      tools: [],
      prompts: [],
      retrievers: [],
      workflows: [],
      agents: [],
      rankingStrategies: [],
      logSinks: [],
      spanExporters: [],
      metricExporters: [],
      caches: [],
      providesMemory: false,
      providesServices: false,
      providesEmbeddings: false,
      providesVectorStore: false,
      subscribesToEvents: false,
    };

    if (has(PluginCapability.ToolProvider)) {
      const contributions = (plugin as AgentPlugin & ToolProvider).getTools();
      summary.tools = this.harvestNamed(
        this.tools,
        'tool',
        id,
        contributions.map((value) => ({ name: toolName(id, value), value })),
      );
    }

    if (has(PluginCapability.PromptProvider)) {
      const contributions = (plugin as AgentPlugin & PromptProvider).getPrompts();
      summary.prompts = this.harvestNamed(this.prompts, 'prompt', id,
        contributions.map((value) => ({ name: value.name, value })));
    }

    if (has(PluginCapability.RetrieverProvider)) {
      const contributions = (plugin as AgentPlugin & RetrieverProvider).getRetrievers();
      summary.retrievers = this.harvestNamed(this.retrievers, 'retriever', id,
        contributions.map((value) => ({ name: value.name, value })));
    }

    if (has(PluginCapability.WorkflowProvider)) {
      const contributions = (plugin as AgentPlugin & WorkflowProvider).getWorkflows();
      summary.workflows = this.harvestNamed(this.workflows, 'workflow', id,
        contributions.map((value) => ({ name: value.name, value })));
    }

    if (has(PluginCapability.AgentProvider)) {
      const contributions = (plugin as AgentPlugin & AgentProvider).getAgents();
      summary.agents = this.harvestNamed(this.agents, 'agent', id,
        contributions.map((value) => ({ name: value.name, value })));
    }

    if (has(PluginCapability.RankingStrategyProvider)) {
      const contributions = (plugin as AgentPlugin & RankingStrategyProvider).getRankingStrategies();
      summary.rankingStrategies = this.harvestNamed(this.rankingStrategies, 'ranking strategy', id,
        contributions.map((value) => ({ name: value.name, value })));
    }

    if (has(PluginCapability.LogSinkProvider)) {
      const contributions = (plugin as AgentPlugin & LogSinkProvider).getLogSinks();
      summary.logSinks = this.harvestNamed(this.logSinks, 'log sink', id,
        contributions.map((value) => ({ name: value.name, value })));
    }

    if (has(PluginCapability.SpanExporterProvider)) {
      const contributions = (plugin as AgentPlugin & SpanExporterProvider).getSpanExporters();
      summary.spanExporters = this.harvestNamed(this.spanExporters, 'span exporter', id,
        contributions.map((value) => ({ name: value.name, value })));
    }

    if (has(PluginCapability.MetricExporterProvider)) {
      const contributions = (plugin as AgentPlugin & MetricExporterProvider).getMetricExporters();
      summary.metricExporters = this.harvestNamed(this.metricExporters, 'metric exporter', id,
        contributions.map((value) => ({ name: value.name, value })));
    }

    if (has(PluginCapability.CacheProvider)) {
      const contributions = (plugin as AgentPlugin & CacheProvider).getCaches();
      summary.caches = this.harvestNamed(this.caches, 'cache', id,
        contributions.map((value) => ({ name: value.name, value })));
    }

    if (has(PluginCapability.MemoryProvider)) {
      this.memoryProviders.set(id, plugin as AgentPlugin & MemoryProvider);
      summary.providesMemory = true;
    }

    if (has(PluginCapability.EmbeddingProvider)) {
      this.embeddingProviders.set(
        id,
        (plugin as AgentPlugin & EmbeddingProvider).getEmbeddingProvider(),
      );
      summary.providesEmbeddings = true;
    }

    if (has(PluginCapability.VectorStoreProvider)) {
      this.vectorStores.set(
        id,
        (plugin as AgentPlugin & VectorStoreProvider).getVectorStore(),
      );
      summary.providesVectorStore = true;
    }

    if (has(PluginCapability.EventSubscriber)) {
      const subscriber = plugin as AgentPlugin & EventSubscriber;
      this.eventSubscribers.set(id, subscriber);
      summary.subscribesToEvents = true;

      // Activate the capability: the plugin's onEvent receives every
      // framework event (EventEnvelope satisfies FrameworkEvent). Bus
      // handler isolation contains a throwing subscriber.
      if (this.eventBus) {
        const handler: EventHandler = (envelope) => subscriber.onEvent(envelope);
        this.busSubscriptions.set(id, handler);
        this.eventBus.subscribe('*', handler);
      }
    }

    if (has(PluginCapability.ServiceProvider)) {
      this.serviceProviders.set(id, plugin as AgentPlugin & ServiceProviderLike);
      summary.providesServices = true;
    }

    return summary;
  }

  // One harvester for every named catalog: validate ALL entries before
  // committing ANY (atomicity), reject empty names, in-plugin duplicates,
  // and cross-plugin collisions — naming both owners.
  private harvestNamed<T>(
    catalog: Map<string, Owned<T>>,
    kind: string,
    pluginId: string,
    entries: { name: string; value: T }[],
  ): string[] {
    const seen = new Set<string>();

    for (const { name } of entries) {
      if (name.trim() === '') {
        throw new PluginValidationError(pluginId, `contributed a ${kind} without a name`);
      }

      if (seen.has(name)) {
        throw new PluginValidationError(pluginId, `contributes duplicate ${kind} names ("${name}")`);
      }
      seen.add(name);

      const existing = catalog.get(name);
      if (existing) {
        throw new PluginError(
          pluginId,
          `${capitalize(kind)} "${name}" from plugin "${pluginId}" collides ` +
            `with the same ${kind} from plugin "${existing.pluginId}".`,
        );
      }
    }

    for (const { name, value } of entries) {
      catalog.set(name, { value, pluginId });
    }

    return entries.map((entry) => entry.name);
  }

  // Plugins see only this narrow surface, namespaced by their id.
  private createContext(plugin: AgentPlugin): PluginContext {
    const pluginLogger = this.logger?.child(plugin.metadata.id);

    return {
      log(message: string): void {
        if (pluginLogger) {
          pluginLogger.info(message);
        } else {
          console.log(`[plugin:${plugin.metadata.id}] ${message}`);
        }
      },
    };
  }

  private release(pluginId: string): void {
    const catalogs = [
      this.tools, this.prompts, this.retrievers, this.workflows,
      this.agents, this.rankingStrategies, this.logSinks, this.spanExporters,
      this.metricExporters, this.caches,
    ];

    for (const catalog of catalogs) {
      for (const [name, entry] of catalog) {
        if (entry.pluginId === pluginId) {
          catalog.delete(name);
        }
      }
    }

    this.memoryProviders.delete(pluginId);
    this.eventSubscribers.delete(pluginId);
    this.serviceProviders.delete(pluginId);
    this.embeddingProviders.delete(pluginId);
    this.vectorStores.delete(pluginId);
    this.installations.delete(pluginId);

    const handler = this.busSubscriptions.get(pluginId);
    if (handler && this.eventBus) {
      this.eventBus.unsubscribe('*', handler);
    }
    this.busSubscriptions.delete(pluginId);
  }
}

interface ServiceProviderLike {
  registerServices(services: ServiceCollection): void;
}

function validateDeclaredCapabilities(plugin: AgentPlugin): void {
  for (const capability of plugin.metadata.capabilities) {
    const method = CAPABILITY_METHODS[capability];

    if (typeof (plugin as unknown as Record<string, unknown>)[method] !== 'function') {
      throw new PluginValidationError(
        plugin.metadata.id,
        `declares ${capability} but does not implement ${method}()`,
      );
    }
  }
}

function toolName(pluginId: string, contribution: ToolContribution): string {
  if (contribution.definition.type !== 'function') {
    throw new PluginValidationError(pluginId, 'contributed a non-function tool');
  }

  return contribution.definition.function.name;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
