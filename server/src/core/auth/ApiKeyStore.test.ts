import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthError } from './AuthError.ts';
import { ApiKeyStore, parseApiKeyDefinitions } from './ApiKeyStore.ts';

describe('parseApiKeyDefinitions', () => {
  test('returns an empty array for blank input', () => {
    assert.deepEqual(parseApiKeyDefinitions(''), []);
    assert.deepEqual(parseApiKeyDefinitions('   '), []);
  });

  test('parses a single entry', () => {
    assert.deepEqual(parseApiKeyDefinitions('k1:alice:admin'), [
      { key: 'k1', subject: 'alice', roles: ['admin'] },
    ]);
  });

  test('parses multiple pipe-separated roles and comma-separated entries', () => {
    assert.deepEqual(parseApiKeyDefinitions('k1:alice:admin|viewer,k2:bob:viewer'), [
      { key: 'k1', subject: 'alice', roles: ['admin', 'viewer'] },
      { key: 'k2', subject: 'bob', roles: ['viewer'] },
    ]);
  });

  test('rejects a malformed entry', () => {
    assert.throws(() => parseApiKeyDefinitions('k1:alice'), AuthError);
    assert.throws(() => parseApiKeyDefinitions('k1::admin'), AuthError);
  });
});

describe('ApiKeyStore', () => {
  test('verifies a configured key and returns its principal', () => {
    const store = new ApiKeyStore([{ key: 'k1', subject: 'alice', roles: ['admin'] }]);
    assert.deepEqual(store.verify('k1'), { subject: 'alice', roles: ['admin'], authMethod: 'api-key' });
  });

  test('an unknown key returns undefined, never throws', () => {
    const store = new ApiKeyStore([{ key: 'k1', subject: 'alice', roles: ['admin'] }]);
    assert.equal(store.verify('nope'), undefined);
  });

  test('size reflects the number of configured keys', () => {
    assert.equal(new ApiKeyStore().size, 0);
    assert.equal(
      new ApiKeyStore([
        { key: 'k1', subject: 'alice', roles: ['admin'] },
        { key: 'k2', subject: 'bob', roles: ['viewer'] },
      ]).size,
      2,
    );
  });
});
