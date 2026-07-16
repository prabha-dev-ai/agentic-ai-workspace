// Every permission the gateway checks route access against. Dot-namespaced
// strings, same convention as EventType/MetricType — a const-object union
// instead of a TS enum (Node's type stripping cannot run enums).
export const Permission = {
  ChatWrite: 'chat:write',
  AgentRead: 'agent:read',
  AgentWrite: 'agent:write',
  WorkflowRead: 'workflow:read',
  WorkflowWrite: 'workflow:write',
  DiagnosticsRead: 'diagnostics:read',
  MetricsRead: 'metrics:read',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];
