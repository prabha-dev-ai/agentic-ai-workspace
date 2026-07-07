import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityError } from './SecurityError.ts';
import { Secret } from './Secret.ts';
import { ApiKeyProvider } from './ApiKeyProvider.ts';
import { SecretRedactor } from './SecretRedactor.ts';
import { ValidationError, validateInput } from './InputValidator.ts';
import { DEFAULT_SECURITY_POLICY } from './SecurityPolicy.ts';
import type { SecurityPolicy } from './SecurityPolicy.ts';
import { SecurityService } from './SecurityService.ts';
import { PluginLoader, PluginRegistry, PluginCapability } from '../plugins/index.ts';
import type { AgentPlugin, SecretProvider } from '../plugins/index.ts';
import type { SecretSource } from './SecretSource.ts';

describe('Secret', () => {
  test('reveal() returns the raw value', () => {
    const secret = new Secret('sk-abc123');
    assert.equal(secret.reveal(), 'sk-abc123');
  });

  test('toString() and toJSON() never leak the raw value', () => {
    const secret = new Secret('sk-abc123');

    assert.equal(String(secret), '[REDACTED]');
    assert.equal(JSON.stringify({ key: secret }), '{"key":"[REDACTED]"}');
    assert.equal(`${secret}`, '[REDACTED]');
  });

  test('an empty value is rejected', () => {
    assert.throws(() => new Secret(''), SecurityError);
  });
});

describe('ApiKeyProvider', () => {
  test('resolves a configured key by name', () => {
    const provider = new ApiKeyProvider({ llm: 'sk-abc123' });
    assert.equal(provider.getSecret('llm'), 'sk-abc123');
  });

  test('returns undefined for an unconfigured name', () => {
    const provider = new ApiKeyProvider({ llm: 'sk-abc123' });
    assert.equal(provider.getSecret('other'), undefined);
  });

  test('blank values are treated as not configured', () => {
    const provider = new ApiKeyProvider({ llm: '  ' });
    assert.equal(provider.getSecret('llm'), undefined);
  });

  test('exposes its provider name', () => {
    const provider = new ApiKeyProvider({});
    assert.equal(provider.name, 'api-keys');
  });
});

describe('SecretRedactor', () => {
  test('redact() replaces every occurrence of a protected value', () => {
    const redactor = new SecretRedactor();
    redactor.protect('sk-abc123');

    assert.equal(
      redactor.redact('key=sk-abc123 and again sk-abc123'),
      'key=[REDACTED] and again [REDACTED]',
    );
  });

  test('text with nothing protected passes through unchanged', () => {
    const redactor = new SecretRedactor();
    assert.equal(redactor.redact('nothing sensitive here'), 'nothing sensitive here');
  });

  test('protecting an empty or whitespace-only value is a no-op', () => {
    const redactor = new SecretRedactor();
    redactor.protect('');
    redactor.protect('   ');

    assert.equal(redactor.protectedCount, 0);
    assert.equal(redactor.redact('anything at all'), 'anything at all');
  });

  test('longer protected values are redacted before shorter ones that are their prefix', () => {
    const redactor = new SecretRedactor();
    redactor.protect('sk-1234');
    redactor.protect('sk-12345678');

    assert.equal(redactor.redact('token: sk-12345678'), 'token: [REDACTED]');
  });

  test('protectedCount reflects distinct protected values', () => {
    const redactor = new SecretRedactor();
    redactor.protect('a');
    redactor.protect('b');
    redactor.protect('a');

    assert.equal(redactor.protectedCount, 2);
  });

  test('redactObject deep-redacts strings inside nested objects and arrays', () => {
    const redactor = new SecretRedactor();
    redactor.protect('sk-abc123');

    const result = redactor.redactObject({
      user: 'alice',
      auth: { token: 'sk-abc123' },
      history: ['ok', 'used sk-abc123 here'],
      retries: 3,
      active: true,
    });

    assert.deepEqual(result, {
      user: 'alice',
      auth: { token: '[REDACTED]' },
      history: ['ok', 'used [REDACTED] here'],
      retries: 3,
      active: true,
    });
  });

  test('redactObject leaves non-plain objects like Date untouched', () => {
    const redactor = new SecretRedactor();
    redactor.protect('sk-abc123');
    const date = new Date('2026-01-01T00:00:00.000Z');

    const result = redactor.redactObject({ at: date });

    assert.equal(result.at, date);
  });
});

describe('validateInput', () => {
  const policy: SecurityPolicy = {
    maxInputLength: 10,
    blockedPatterns: [/bad/],
    autoRedactSecrets: true,
  };

  test('accepts input within the policy', () => {
    assert.doesNotThrow(() => validateInput('ok text', policy));
  });

  test('rejects input over maxInputLength', () => {
    assert.throws(() => validateInput('this is way too long', policy), ValidationError);
  });

  test('rejects input matching a blocked pattern', () => {
    assert.throws(() => validateInput('bad input', policy), ValidationError);
  });

  test('the field name is reported in the error message', () => {
    assert.throws(
      () => validateInput('this is way too long', policy, 'prompt'),
      /"prompt"/,
    );
  });

  test('the default policy blocks control characters', () => {
    assert.throws(
      () => validateInput('hello\x00world', DEFAULT_SECURITY_POLICY),
      ValidationError,
    );
  });
});

describe('SecurityService: secret sources', () => {
  test('getSecret finds a value from a registered source and wraps it in a Secret', () => {
    const security = new SecurityService();
    security.addSecretSource(new ApiKeyProvider({ llm: 'sk-abc123' }));

    const secret = security.getSecret('llm');
    assert.ok(secret instanceof Secret);
    assert.equal(secret?.reveal(), 'sk-abc123');
  });

  test('missing secrets return undefined and are counted', () => {
    const security = new SecurityService();

    assert.equal(security.getSecret('missing'), undefined);
    assert.equal(security.getDiagnostics().secretsMissing, 1);
  });

  test('sources are checked in registration order; first match wins', () => {
    const security = new SecurityService();
    security.addSecretSource({ name: 'a', getSecret: () => 'from-a' });
    security.addSecretSource({ name: 'b', getSecret: () => 'from-b' });

    assert.equal(security.getSecret('llm')?.reveal(), 'from-a');
  });

  test('duplicate source names fail loudly; removeSecretSource stops lookups', () => {
    const security = new SecurityService();
    security.addSecretSource(new ApiKeyProvider({ llm: 'sk-abc123' }));

    assert.throws(() => security.addSecretSource(new ApiKeyProvider({})), SecurityError);

    security.removeSecretSource('api-keys');
    assert.equal(security.getSecret('llm'), undefined);
    assert.throws(() => security.removeSecretSource('api-keys'), SecurityError);
  });

  test('an unnamed source is rejected', () => {
    const security = new SecurityService();
    assert.throws(() => security.addSecretSource({ name: '', getSecret: () => undefined }), SecurityError);
  });
});

describe('SecurityService: redaction integration', () => {
  test('getSecret auto-protects the resolved value when the policy allows it', () => {
    const security = new SecurityService();
    security.addSecretSource(new ApiKeyProvider({ llm: 'sk-abc123' }));

    security.getSecret('llm');

    assert.equal(security.redact('key=sk-abc123'), 'key=[REDACTED]');
    assert.equal(security.getDiagnostics().protectedValues, 1);
  });

  test('auto-redaction is skipped when the policy disables it', () => {
    const security = new SecurityService({ ...DEFAULT_SECURITY_POLICY, autoRedactSecrets: false });
    security.addSecretSource(new ApiKeyProvider({ llm: 'sk-abc123' }));

    security.getSecret('llm');

    assert.equal(security.redact('key=sk-abc123'), 'key=sk-abc123');
  });

  test('protect() explicitly marks any value as sensitive', () => {
    const security = new SecurityService();
    security.protect('manual-secret');

    assert.equal(security.redact('value=manual-secret'), 'value=[REDACTED]');
  });

  test('redactObject delegates to the underlying redactor', () => {
    const security = new SecurityService();
    security.protect('sk-abc123');

    assert.deepEqual(security.redactObject({ token: 'sk-abc123' }), { token: '[REDACTED]' });
  });
});

describe('SecurityService: policy', () => {
  test('defaults to DEFAULT_SECURITY_POLICY', () => {
    const security = new SecurityService();
    assert.equal(security.getPolicy(), DEFAULT_SECURITY_POLICY);
  });

  test('setPolicy replaces the active policy for subsequent validation', () => {
    const security = new SecurityService();
    security.setPolicy({ maxInputLength: 3, blockedPatterns: [], autoRedactSecrets: true });

    assert.throws(() => security.validateInput('too long'), ValidationError);
    assert.equal(security.getPolicy().maxInputLength, 3);
  });
});

describe('SecurityService: validateInput', () => {
  test('valid input passes and is counted', () => {
    const security = new SecurityService();
    security.validateInput('a perfectly normal prompt');

    assert.equal(security.getDiagnostics().validationsPassed, 1);
    assert.equal(security.getDiagnostics().validationsRejected, 0);
  });

  test('invalid input throws and is counted, without affecting the passed counter', () => {
    const security = new SecurityService();
    security.setPolicy({ maxInputLength: 3, blockedPatterns: [], autoRedactSecrets: true });

    assert.throws(() => security.validateInput('too long'), ValidationError);
    assert.equal(security.getDiagnostics().validationsRejected, 1);
    assert.equal(security.getDiagnostics().validationsPassed, 0);
  });
});

describe('SecurityService: diagnostics', () => {
  test('reports the full picture: sources, secret counts, redaction, validation, policy', () => {
    const security = new SecurityService();
    security.addSecretSource(new ApiKeyProvider({ llm: 'sk-abc123' }));

    security.getSecret('llm');
    security.getSecret('missing');
    security.validateInput('ok');
    try {
      security.validateInput('x'.repeat(DEFAULT_SECURITY_POLICY.maxInputLength + 1));
    } catch {
      // expected
    }

    const diagnostics = security.getDiagnostics();
    assert.deepEqual(diagnostics.secretSources, ['api-keys']);
    assert.equal(diagnostics.secretsResolved, 1);
    assert.equal(diagnostics.secretsMissing, 1);
    assert.equal(diagnostics.protectedValues, 1);
    assert.equal(diagnostics.validationsPassed, 1);
    assert.equal(diagnostics.validationsRejected, 1);
    assert.equal(diagnostics.policy, DEFAULT_SECURITY_POLICY);
  });
});

describe('secret provider plugin capability', () => {
  function makeSecretPlugin(source: SecretSource): AgentPlugin & SecretProvider {
    return {
      metadata: {
        id: 'test.secret-source',
        name: 'Secret Source Plugin',
        version: '1.0.0',
        description: 'test',
        author: 'tests',
        capabilities: [PluginCapability.SecretProvider],
      },
      register() {},
      getSecretSources: () => [source],
    };
  }

  test('contributed sources are harvested, recorded and released', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const source: SecretSource = { name: 'vault', getSecret: () => 'from-vault' };

    await loader.install(makeSecretPlugin(source));

    assert.deepEqual(loader.getSecretSources().map((entry) => entry.name), ['vault']);
    assert.deepEqual(
      loader.getInstallation('test.secret-source').contributions.secretSources,
      ['vault'],
    );

    await loader.uninstall('test.secret-source');
    assert.deepEqual(loader.getSecretSources(), []);
  });

  test('a contributed source wired into the service is reachable by getSecret', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const source: SecretSource = { name: 'vault', getSecret: (name) => (name === 'db' ? 'db-pass' : undefined) };
    await loader.install(makeSecretPlugin(source));

    const security = new SecurityService();
    for (const contributed of loader.getSecretSources()) {
      security.addSecretSource(contributed);
    }

    assert.equal(security.getSecret('db')?.reveal(), 'db-pass');
  });
});
