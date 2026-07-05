// Typed plugin errors. Callers can catch precisely (instanceof) instead
// of string-matching messages, and every error carries the plugin id.

export class PluginError extends Error {
  readonly pluginId: string;

  constructor(pluginId: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.pluginId = pluginId;
  }
}

export class DuplicatePluginError extends PluginError {
  constructor(pluginId: string) {
    super(pluginId, `Plugin "${pluginId}" is already registered.`);
  }
}

export class PluginNotFoundError extends PluginError {
  constructor(pluginId: string) {
    super(pluginId, `Plugin "${pluginId}" is not registered.`);
  }
}

export class PluginValidationError extends PluginError {
  constructor(pluginId: string, reason: string) {
    super(pluginId || '<unknown>', `Plugin "${pluginId || '<unknown>'}" is invalid: ${reason}`);
  }
}
