import { PluginCapability } from './PluginCapability.ts';
import {
  DuplicatePluginError,
  PluginNotFoundError,
  PluginValidationError,
} from './PluginErrors.ts';
import type { AgentPlugin } from './AgentPlugin.ts';

const KNOWN_CAPABILITIES = new Set<string>(Object.values(PluginCapability));

// "1.0.0" or "1.0.0-beta.1" — deliberately simple, not full semver.
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

// A passive, validated catalog of installed plugins. The registry answers
// "what is installed?" and "who provides capability X?" — it never
// executes plugin code. Invoking register()/dispose() hooks and consuming
// provider interfaces is the plugin loader's job (future story).
export class PluginRegistry {
  private readonly plugins = new Map<string, AgentPlugin>();

  register(plugin: AgentPlugin): void {
    validateMetadata(plugin);

    // Two plugins with one id means one silently wins — fail loudly.
    if (this.plugins.has(plugin.metadata.id)) {
      throw new DuplicatePluginError(plugin.metadata.id);
    }

    this.plugins.set(plugin.metadata.id, plugin);
  }

  /**
   * Remove a plugin from the catalog. Does NOT call dispose() — the
   * loader owns lifecycle, the registry owns bookkeeping.
   */
  unregister(id: string): void {
    if (!this.plugins.delete(id)) {
      throw new PluginNotFoundError(id);
    }
  }

  /** Required lookup: throws PluginNotFoundError. Use exists() to probe. */
  get(id: string): AgentPlugin {
    const plugin = this.plugins.get(id);

    if (!plugin) {
      throw new PluginNotFoundError(id);
    }

    return plugin;
  }

  exists(id: string): boolean {
    return this.plugins.has(id);
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

function validateMetadata(plugin: AgentPlugin): void {
  const { metadata } = plugin;
  const id = metadata.id ?? '';

  if (id.trim() === '') {
    throw new PluginValidationError(id, 'metadata.id must be a non-empty string');
  }

  if (metadata.name.trim() === '') {
    throw new PluginValidationError(id, 'metadata.name must be a non-empty string');
  }

  if (!VERSION_PATTERN.test(metadata.version)) {
    throw new PluginValidationError(
      id,
      `metadata.version "${metadata.version}" is not a valid semver version`,
    );
  }

  if (
    metadata.minimumFrameworkVersion !== undefined &&
    !VERSION_PATTERN.test(metadata.minimumFrameworkVersion)
  ) {
    throw new PluginValidationError(
      id,
      `metadata.minimumFrameworkVersion "${metadata.minimumFrameworkVersion}" is not a valid semver version`,
    );
  }

  for (const capability of metadata.capabilities) {
    if (!KNOWN_CAPABILITIES.has(capability)) {
      throw new PluginValidationError(
        id,
        `unknown capability "${capability}"`,
      );
    }
  }
}
