// Scrubs known secret values out of text and structured data before it
// reaches a log line, an error message, or any other output. Tracks the
// values to protect as an explicit set — nothing is redacted until
// something has actually called protect() on it.
export class SecretRedactor {
  private readonly values = new Set<string>();

  /** Mark a value as sensitive. Empty strings are ignored — protecting ''
   *  would redact everything, which defeats the purpose. */
  protect(value: string): void {
    if (value.trim() === '') {
      return;
    }
    this.values.add(value);
  }

  get protectedCount(): number {
    return this.values.size;
  }

  /** Replace every occurrence of every protected value with a placeholder.
   *  Longest values first, so a secret that is a prefix of another
   *  protected value can't leave a redacted fragment of the longer one
   *  behind. */
  redact(text: string): string {
    let redacted = text;
    for (const value of this.longestFirst()) {
      redacted = redacted.split(value).join('[REDACTED]');
    }
    return redacted;
  }

  /** Deep-redact every string found in a plain object or array, leaving
   *  everything else (numbers, booleans, Dates, other class instances)
   *  untouched. Useful for scrubbing structured log fields before they're
   *  written anywhere. */
  redactObject<T>(input: T): T {
    return this.redactValue(input) as T;
  }

  private redactValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.redact(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item));
    }
    if (isPlainObject(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = this.redactValue(val);
      }
      return result;
    }
    return value;
  }

  private longestFirst(): string[] {
    return [...this.values].sort((a, b) => b.length - a.length);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && value.constructor === Object;
}
