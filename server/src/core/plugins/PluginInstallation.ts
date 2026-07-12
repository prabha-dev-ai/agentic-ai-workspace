// Installation diagnostics: what a plugin actually contributed, recorded
// at install time. This is the operational answer to "why does this tool
// exist?" and "what breaks if I uninstall plugin X?" — without executing
// any plugin code to find out.

/** Names per named-contribution kind; flags for the unnamed kinds. */
export interface PluginContributionSummary {
  tools: string[];
  prompts: string[];
  retrievers: string[];
  workflows: string[];
  agents: string[];
  rankingStrategies: string[];
  logSinks: string[];
  spanExporters: string[];
  metricExporters: string[];
  caches: string[];
  secretSources: string[];
  streamObservers: string[];
  interactionObservers: string[];
  workflowDefinitions: string[];
  asyncCaches: string[];
  providesMemory: boolean;
  providesServices: boolean;
  providesEmbeddings: boolean;
  providesVectorStore: boolean;
  providesCheckpointStore: boolean;
  providesAsyncCheckpointStore: boolean;
  providesAsyncKnowledgeStore: boolean;
  subscribesToEvents: boolean;
}

export interface PluginInstallation {
  pluginId: string;
  installedAt: Date;
  contributions: PluginContributionSummary;
}
