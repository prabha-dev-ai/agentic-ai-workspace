import { PluginCapability } from './PluginCapability.ts';
import { PluginError, PluginValidationError } from './PluginErrors.ts';
import type OpenAI from 'openai';
import type { AgentPlugin } from './AgentPlugin.ts';
import type { PluginContext } from './PluginContext.ts';
import type { PluginRegistry } from './PluginRegistry.ts';
import type { ToolContribution, ToolProvider } from './PluginCapability.ts';

// The lifecycle owner. The registry is passive bookkeeping; the loader
// installs plugins (validate -> catalog -> run register() hook -> harvest
// capabilities) and uninstalls them (dispose() -> release contributions).
// Installation is atomic: any failure rolls the plugin back completely.
//
// The loader is also the framework's tool source: it aggregates every
// installed ToolProvider's contributions behind getToolDefinitions() /
// executeTool() — the surface the agent loop consumes.
export class PluginLoader {
  private readonly registry: PluginRegistry;
  private readonly tools = new Map<
    string,
    { contribution: ToolContribution; pluginId: string }
  >();

  constructor(registry: PluginRegistry) {
    this.registry = registry;
  }

  async install(plugin: AgentPlugin): Promise<void> {
    // Catalog first: metadata validation and duplicate-id rejection.
    this.registry.register(plugin);

    try {
      await plugin.register(createContext(plugin));
      this.harvestTools(plugin);
    } catch (error) {
      // Atomic install: a plugin that failed half-way is not installed.
      this.registry.unregister(plugin.metadata.id);
      this.releaseTools(plugin.metadata.id);
      throw error;
    }
  }

  async uninstall(id: string): Promise<void> {
    const plugin = this.registry.get(id);

    await plugin.dispose?.();
    this.releaseTools(id);
    this.registry.unregister(id);
  }

  /** Every installed tool definition — the model-facing menu. */
  getToolDefinitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return [...this.tools.values()].map((entry) => entry.contribution.definition);
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

    return entry.contribution.execute(args);
  }

  private harvestTools(plugin: AgentPlugin): void {
    const { id, capabilities } = plugin.metadata;

    if (!capabilities.includes(PluginCapability.ToolProvider)) {
      return;
    }

    const provider = plugin as AgentPlugin & Partial<ToolProvider>;

    // Declaring a capability without implementing it is a broken plugin.
    if (typeof provider.getTools !== 'function') {
      throw new PluginValidationError(
        id,
        'declares tool-provider but does not implement getTools()',
      );
    }

    // Validate every contribution BEFORE committing any (atomicity).
    const validated = provider.getTools().map((contribution) => {
      if (contribution.definition.type !== 'function') {
        throw new PluginValidationError(id, 'contributed a non-function tool');
      }

      const toolName = contribution.definition.function.name;
      const existing = this.tools.get(toolName);

      if (existing) {
        throw new PluginError(
          id,
          `Tool "${toolName}" from plugin "${id}" collides with the same ` +
            `tool from plugin "${existing.pluginId}".`,
        );
      }

      return { toolName, contribution };
    });

    const names = validated.map((entry) => entry.toolName);
    if (new Set(names).size !== names.length) {
      throw new PluginValidationError(id, 'contributes duplicate tool names');
    }

    for (const { toolName, contribution } of validated) {
      this.tools.set(toolName, { contribution, pluginId: id });
    }
  }

  private releaseTools(pluginId: string): void {
    for (const [name, entry] of this.tools) {
      if (entry.pluginId === pluginId) {
        this.tools.delete(name);
      }
    }
  }
}

// Plugins see only this narrow surface, namespaced by their id.
function createContext(plugin: AgentPlugin): PluginContext {
  return {
    log(message: string): void {
      console.log(`[plugin:${plugin.metadata.id}] ${message}`);
    },
  };
}
