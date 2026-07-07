import { SecurityError } from './SecurityError.ts';

// The secret abstraction: a value that must never leak into a log line,
// an error message, or a JSON.stringify() by accident. toString()/toJSON()
// return a placeholder — the only way to get the real value out is the
// explicit reveal() call, which reads as a deliberate act at the call site.
export class Secret {
  private readonly value: string;

  constructor(value: string) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new SecurityError('A secret needs a non-empty value.');
    }
    this.value = value;
  }

  reveal(): string {
    return this.value;
  }

  toString(): string {
    return '[REDACTED]';
  }

  toJSON(): string {
    return '[REDACTED]';
  }
}
