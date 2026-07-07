import type { SecretSource } from './SecretSource.ts';

// The default secret source: a fixed set of named API keys, supplied at
// construction rather than reading the environment directly — config/env.ts
// is the only place allowed to touch environment variables, per the
// architecture's ownership rule (see architecture.test.ts). This provider
// just holds whatever it's handed.
export class ApiKeyProvider implements SecretSource {
  readonly name = 'api-keys';
  private readonly keys: ReadonlyMap<string, string>;

  constructor(keys: Record<string, string>) {
    this.keys = new Map(
      Object.entries(keys).filter(([, value]) => value.trim() !== ''),
    );
  }

  getSecret(name: string): string | undefined {
    return this.keys.get(name);
  }
}
