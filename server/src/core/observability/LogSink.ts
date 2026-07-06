import type { LogEntry } from './LogEntry.ts';

// Where entries go. The service fans every accepted entry out to all
// sinks; plugins contribute additional sinks (files, remote collectors)
// through the log-sink-provider capability.
export interface LogSink {
  readonly name: string;
  write(entry: LogEntry): void;
}

// The default sink: one JSON line per entry. Machine-parseable output
// is the whole point of structured logging — anything that reads logs
// (grep, jq, a collector) gets fields, not prose.
export class ConsoleLogSink implements LogSink {
  readonly name = 'console';

  write(entry: LogEntry): void {
    const line = JSON.stringify({
      timestamp: entry.timestamp.toISOString(),
      level: entry.level,
      component: entry.component,
      message: entry.message,
      ...(entry.correlationId !== undefined && {
        correlationId: entry.correlationId,
      }),
      ...(entry.fields !== undefined && { fields: entry.fields }),
    });

    // Warnings and errors go to stderr so shell redirection separates
    // signal from noise.
    if (entry.level === 'warn' || entry.level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

// An in-memory sink for tests and short-lived inspection — the log
// equivalent of the in-memory vector store.
export class MemoryLogSink implements LogSink {
  readonly name: string;
  readonly entries: LogEntry[] = [];

  constructor(name = 'memory') {
    this.name = name;
  }

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }

  clear(): void {
    this.entries.length = 0;
  }
}
