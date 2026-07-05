import type { PluginMetadata } from './PluginMetadata.ts';
import type { PluginContext } from './PluginContext.ts';

// The plugin interface. Minimal on purpose: identity (metadata) plus
// lifecycle hooks. Everything else a plugin can do is expressed through
// the capability provider interfaces it additionally implements.
export interface AgentPlugin {
  readonly metadata: PluginMetadata;

  /**
   * Called once when the framework installs the plugin. May be async —
   * real plugins open connections or read configuration here. Invoked by
   * the plugin loader (future story), NOT by the registry.
   */
  register(context: PluginContext): void | Promise<void>;

  /**
   * Optional teardown, called when the plugin is uninstalled or the
   * framework shuts down: close connections, flush buffers, release
   * resources. Also invoked by the loader, never by the registry.
   */
  dispose?(): void | Promise<void>;
}
