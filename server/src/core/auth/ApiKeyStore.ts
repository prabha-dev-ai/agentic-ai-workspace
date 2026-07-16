import { AuthError } from './AuthError.ts';
import type { Principal } from './Principal.ts';

export interface ApiKeyDefinition {
  key: string;
  subject: string;
  roles: string[];
}

// A static directory of API keys mapped to principals, parsed once from
// configuration (config/env.ts's API_KEYS format, via
// parseApiKeyDefinitions below). Verification is a constant-time-free map
// lookup — no network, no database — the same reference-implementation
// trade-off already documented on InMemoryVectorStore/InMemoryCheckpointStore.
export class ApiKeyStore {
  private readonly principals = new Map<string, Principal>();

  constructor(definitions: readonly ApiKeyDefinition[] = []) {
    for (const definition of definitions) {
      this.principals.set(definition.key, {
        subject: definition.subject,
        roles: definition.roles,
        authMethod: 'api-key',
      });
    }
  }

  get size(): number {
    return this.principals.size;
  }

  /** Never throws for an unknown key — that's an authentication failure,
   *  not a programming error. */
  verify(key: string): Principal | undefined {
    return this.principals.get(key);
  }
}

/**
 * Parses the API_KEYS configuration format:
 * "key:subject:role1|role2,key2:subject2:role3" — comma-separated entries,
 * each a colon-separated (key, subject, pipe-separated roles) triple.
 * Throws AuthError on a malformed entry — configuration mistakes should
 * fail loudly at startup, not silently produce an unusable key.
 */
export function parseApiKeyDefinitions(raw: string): ApiKeyDefinition[] {
  if (raw.trim() === '') {
    return [];
  }

  return raw.split(',').map((entry) => {
    const [key, subject, rolesPart] = entry.split(':');
    if (!key || !subject || !rolesPart) {
      throw new AuthError(
        `Malformed API key entry "${entry}" — expected "key:subject:role1|role2".`,
      );
    }
    return { key, subject, roles: rolesPart.split('|').filter((role) => role.trim() !== '') };
  });
}
