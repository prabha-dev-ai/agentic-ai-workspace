// The framework-facing surface a plugin receives in its register() hook.
// Deliberately minimal: this is the STABLE part of the plugin API, so
// every future capability integration lands as an addition here — never
// a breaking change to existing plugins.
export interface PluginContext {
  /** Log a message, namespaced by the framework with the plugin id. */
  log(message: string): void;
}
