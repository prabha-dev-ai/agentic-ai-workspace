import { PluginCapability } from './PluginCapability.ts';
import type { AgentPlugin } from './AgentPlugin.ts';

const KNOWN_CAPABILITIES = new Set<string>(Object.values(PluginCapability));

// A passive, validated catalog of installed plugins. The registry answers
// "what is installed?" and "who provides capability X?" — it never
// executes plugin code. Invoking register() hooks and consuming provider
// interfaces is the plugin loader's job (future story).
export class PluginRegistry {
  private readonly plugins = new Map<string, AgentPlugin>();

  register(plugin: AgentPlugin): void {
    const { metadata } = plugin;

    if (metadata.id.trim() === '') {
      throw new Error('A plugin needs a non-empty metadata.id.');
    }

    if (metadata.name.trim() === '') {
      throw new Error(`Plugin "${metadata.id}" needs a non-empty name.`);
    }

    if (metadata.version.trim() === '') {
      throw new Error(`Plugin "${metadata.id}" needs a version.`);
    }

    for (const capability of metadata.capabilities) {
      if (!KNOWN_CAPABILITIES.has(capability)) {
        throw new Error(
          `Plugin "${metadata.id}" declares unknown capability "${capability}".`,
        );
      }
    }

    // Two plugins with one id means one silently wins — fail loudly.
    if (this.plugins.has(metadata.id)) {
      throw new Error(`Plugin "${metadata.id}" is already registered.`);
    }

    this.plugins.set(metadata.id, plugin);
  }

  get(id: string): AgentPlugin | undefined {
    return this.plugins.get(id);
  }

  list(): AgentPlugin[] {
    return [...this.plugins.values()];
  }

  listByCapability(capability: PluginCapability): AgentPlugin[] {
    return this.list().filter((plugin) =>
      plugin.metadata.capabilities.includes(capability),
    );
  }
}
