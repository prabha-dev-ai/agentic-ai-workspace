import type { PluginMetadata } from './PluginMetadata.ts';
import type { PluginContext } from './PluginContext.ts';

// The plugin interface. Minimal on purpose: identity (metadata) plus one
// lifecycle hook. Everything else a plugin can do is expressed through
// the capability provider interfaces it additionally implements.
export interface AgentPlugin {
  readonly metadata: PluginMetadata;

  /**
   * Called once when the framework installs the plugin. May be async —
   * real plugins open connections or read configuration here. Invoked by
   * the plugin loader (future story), NOT by the registry.
   */
  register(context: PluginContext): void | Promise<void>;
}
