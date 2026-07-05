import type { PluginCapability } from './PluginCapability.ts';

// A plugin's identity card: pure data, no behavior. Capabilities are
// DECLARED here so the framework can answer "what does this plugin do?"
// without executing any plugin code.
export interface PluginMetadata {
  /** Unique machine identity, e.g. "core.time". Registry key. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Plugin version, semver (e.g. "1.0.0"). */
  version: string;
  description: string;
  author: string;
  /** Optional project or documentation URL. */
  homepage?: string;
  /** Optional SPDX license identifier, e.g. "MIT". */
  license?: string;
  /** Oldest framework version this plugin supports, semver. */
  minimumFrameworkVersion?: string;
  /** What this plugin claims to provide. Backed by the matching interfaces. */
  capabilities: PluginCapability[];
}
