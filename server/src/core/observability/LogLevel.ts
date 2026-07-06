// Log levels with numeric severity for threshold filtering. A
// const-object union instead of a TS enum: Node's type stripping
// cannot run enums (same pattern as EventType and PluginCapability).
export const LogLevel = {
  Debug: 'debug',
  Info: 'info',
  Warn: 'warn',
  Error: 'error',
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

const SEVERITY: Record<LogLevel, number> = {
  [LogLevel.Debug]: 10,
  [LogLevel.Info]: 20,
  [LogLevel.Warn]: 30,
  [LogLevel.Error]: 40,
};

/** Does `level` meet the `minimum` threshold? */
export function meetsThreshold(level: LogLevel, minimum: LogLevel): boolean {
  return SEVERITY[level] >= SEVERITY[minimum];
}
