import { PluginCapability } from './PluginCapability.ts';
import { PluginError, PluginValidationError } from './PluginErrors.ts';
import type OpenAI from 'openai';
import type { AgentPlugin } from './AgentPlugin.ts';
import type { PluginContext } from './PluginContext.ts';
import type { PluginRegistry } from './PluginRegistry.ts';
import type { ServiceCollection } from '../container/ServiceCollection.ts';
import type {
  AgentContribution,
  AgentProvider,
  EventSubscriber,
  MemoryProvider,
  PromptContribution,
  PromptProvider,
  RetrieverContribution,
  RetrieverProvider,
  ToolContribution,
  ToolProvider,
  WorkflowContribution,
  WorkflowProvider,
} from './PluginCapability.ts';

// Every capability maps to the method that backs it. Declaring a
// capability without implementing its method fails installation —
// uniformly, for all eight capabilities.
const CAPABILITY_METHODS: Record<PluginCapability, string> = {
  [PluginCapability.ToolProvider]: 'getTools',
  [PluginCapability.PromptProvider]: 'getPrompts',
  [PluginCapability.RetrieverProvider]: 'getRetrievers',
  [PluginCapability.MemoryProvider]: 'createMemoryStore',
  [PluginCapability.ServiceProvider]: 'registerServices',
  [PluginCapability.EventSubscriber]: 'onEvent',
  [PluginCapability.WorkflowProvider]: 'getWorkflows',
  [PluginCapability.AgentProvider]: 'getAgents',
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

  // Unnamed contributions, keyed by owning plugin.
  private readonly memoryProviders = new Map<string, MemoryProvider>();
  private readonly eventSubscribers = new Map<string, EventSubscriber>();
  private readonly serviceProviders = new Map<string, ServiceProviderLike>();

  constructor(registry: PluginRegistry) {
    this.registry = registry;
  }

  async install(plugin: AgentPlugin): Promise<void> {
    // Catalog first: metadata validation and duplicate-id rejection.
    this.registry.register(plugin);

    try {
      validateDeclaredCapabilities(plugin);
      await plugin.register(createContext(plugin));
      this.harvest(plugin);
    } catch (error) {
      // Atomic install: a plugin that failed half-way is not installed.
      this.registry.unregister(plugin.metadata.id);
      this.release(plugin.metadata.id);
      throw error;
    }
  }

  async uninstall(id: string): Promise<void> {
    const plugin = this.registry.get(id);

    await plugin.dispose?.();
    this.release(id);
    this.registry.unregister(id);
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

  private harvest(plugin: AgentPlugin): void {
    const { id, capabilities } = plugin.metadata;
    const has = (capability: PluginCapability) =>
      capabilities.includes(capability);

    if (has(PluginCapability.ToolProvider)) {
      const contributions = (plugin as AgentPlugin & ToolProvider).getTools();
      this.harvestNamed(
        this.tools,
        'tool',
        id,
        contributions.map((value) => ({ name: toolName(id, value), value })),
      );
    }

    if (has(PluginCapability.PromptProvider)) {
      const contributions = (plugin as AgentPlugin & PromptProvider).getPrompts();
      this.harvestNamed(this.prompts, 'prompt', id,
        contributions.map((value) => ({ name: value.name, value })));
    }

    if (has(PluginCapability.RetrieverProvider)) {
      const contributions = (plugin as AgentPlugin & RetrieverProvider).getRetrievers();
      this.harvestNamed(this.retrievers, 'retriever', id,
        contributions.map((value) => ({ name: value.name, value })));
    }

    if (has(PluginCapability.WorkflowProvider)) {
      const contributions = (plugin as AgentPlugin & WorkflowProvider).getWorkflows();
      this.harvestNamed(this.workflows, 'workflow', id,
        contributions.map((value) => ({ name: value.name, value })));
    }

    if (has(PluginCapability.AgentProvider)) {
      const contributions = (plugin as AgentPlugin & AgentProvider).getAgents();
      this.harvestNamed(this.agents, 'agent', id,
        contributions.map((value) => ({ name: value.name, value })));
    }

    if (has(PluginCapability.MemoryProvider)) {
      this.memoryProviders.set(id, plugin as AgentPlugin & MemoryProvider);
    }

    if (has(PluginCapability.EventSubscriber)) {
      this.eventSubscribers.set(id, plugin as AgentPlugin & EventSubscriber);
    }

    if (has(PluginCapability.ServiceProvider)) {
      this.serviceProviders.set(id, plugin as AgentPlugin & ServiceProviderLike);
    }
  }

  // One harvester for every named catalog: validate ALL entries before
  // committing ANY (atomicity), reject empty names, in-plugin duplicates,
  // and cross-plugin collisions — naming both owners.
  private harvestNamed<T>(
    catalog: Map<string, Owned<T>>,
    kind: string,
    pluginId: string,
    entries: { name: string; value: T }[],
  ): void {
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
  }

  private release(pluginId: string): void {
    const catalogs = [this.tools, this.prompts, this.retrievers, this.workflows, this.agents];

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

// Plugins see only this narrow surface, namespaced by their id.
function createContext(plugin: AgentPlugin): PluginContext {
  return {
    log(message: string): void {
      console.log(`[plugin:${plugin.metadata.id}] ${message}`);
    },
  };
}
