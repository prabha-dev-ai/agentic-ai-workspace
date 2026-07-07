import { SecurityError } from './SecurityError.ts';
import { Secret } from './Secret.ts';
import { SecretRedactor } from './SecretRedactor.ts';
import { validateInput } from './InputValidator.ts';
import { DEFAULT_SECURITY_POLICY } from './SecurityPolicy.ts';
import type { SecretSource } from './SecretSource.ts';
import type { SecurityPolicy } from './SecurityPolicy.ts';

export interface SecurityDiagnostics {
  /** Registered secret source names, in registration order. */
  secretSources: string[];
  /** getSecret() calls that resolved to a value. */
  secretsResolved: number;
  /** getSecret() calls that found nothing in any source. */
  secretsMissing: number;
  /** Distinct values currently tracked for redaction. */
  protectedValues: number;
  validationsPassed: number;
  validationsRejected: number;
  policy: SecurityPolicy;
}

// The security hub: components ask it for secrets (getSecret), it fans a
// lookup out across every registered source (first match wins) and
// auto-protects whatever it finds; components ask it to scrub text before
// it's logged (redact/redactObject); components ask it to check untrusted
// input against the active policy (validateInput). Mirrors the other
// registries deliberately — same duplicate-name-fails-loudly source
// registration, same plugin capability shape for contributed sources.
export class SecurityService {
  private readonly sources = new Map<string, SecretSource>();
  private readonly redactor = new SecretRedactor();
  private policy: SecurityPolicy;

  private secretsResolved = 0;
  private secretsMissing = 0;
  private validationsPassed = 0;
  private validationsRejected = 0;

  constructor(policy: SecurityPolicy = DEFAULT_SECURITY_POLICY) {
    this.policy = policy;
  }

  /** Register a secret source. Duplicate names fail loudly — silent
   *  replacement is how "which source is this key actually coming from?"
   *  bugs are born. */
  addSecretSource(source: SecretSource): void {
    if (typeof source.name !== 'string' || source.name.trim() === '') {
      throw new SecurityError('A secret source needs a non-empty name.');
    }
    if (this.sources.has(source.name)) {
      throw new SecurityError(`A secret source named "${source.name}" is already registered.`);
    }
    this.sources.set(source.name, source);
  }

  removeSecretSource(name: string): void {
    if (!this.sources.delete(name)) {
      throw new SecurityError(`No secret source named "${name}" is registered.`);
    }
  }

  /** Look up a secret across every registered source, in registration
   *  order — first match wins. The result is wrapped in a Secret and (if
   *  the policy allows) automatically protected against redaction. */
  getSecret(name: string): Secret | undefined {
    for (const source of this.sources.values()) {
      const value = source.getSecret(name);
      if (value !== undefined) {
        this.secretsResolved++;
        if (this.policy.autoRedactSecrets) {
          this.redactor.protect(value);
        }
        return new Secret(value);
      }
    }

    this.secretsMissing++;
    return undefined;
  }

  /** Explicitly mark a value as sensitive, regardless of where it came from. */
  protect(value: string): void {
    this.redactor.protect(value);
  }

  redact(text: string): string {
    return this.redactor.redact(text);
  }

  redactObject<T>(input: T): T {
    return this.redactor.redactObject(input);
  }

  setPolicy(policy: SecurityPolicy): void {
    this.policy = policy;
  }

  getPolicy(): SecurityPolicy {
    return this.policy;
  }

  /** Validate untrusted input against the active policy. Throws
   *  ValidationError on rejection. */
  validateInput(value: string, fieldName?: string): void {
    try {
      validateInput(value, this.policy, fieldName);
      this.validationsPassed++;
    } catch (error) {
      this.validationsRejected++;
      throw error;
    }
  }

  getDiagnostics(): SecurityDiagnostics {
    return {
      secretSources: [...this.sources.keys()],
      secretsResolved: this.secretsResolved,
      secretsMissing: this.secretsMissing,
      protectedValues: this.redactor.protectedCount,
      validationsPassed: this.validationsPassed,
      validationsRejected: this.validationsRejected,
      policy: this.policy,
    };
  }
}
