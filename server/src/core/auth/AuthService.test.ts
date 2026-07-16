import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiKeyStore } from './ApiKeyStore.ts';
import { JwtService } from './JwtService.ts';
import { Permission } from './Permission.ts';
import { AuthService } from './AuthService.ts';

describe('AuthService: disabled by default', () => {
  test('isEnabled() is false with no ApiKeyStore/JwtService configured', () => {
    assert.equal(new AuthService().isEnabled(), false);
  });

  test('authenticate() fails closed even with no stores configured', () => {
    const auth = new AuthService();
    assert.equal(auth.authenticate('ApiKey', 'anything'), undefined);
    assert.equal(auth.authenticate('Bearer', 'anything'), undefined);
  });
});

describe('AuthService: API key authentication', () => {
  test('isEnabled() is true once an ApiKeyStore has keys', () => {
    const auth = new AuthService({
      apiKeyStore: new ApiKeyStore([{ key: 'k1', subject: 'alice', roles: ['admin'] }]),
    });
    assert.equal(auth.isEnabled(), true);
  });

  test('authenticates a valid key under the ApiKey scheme', () => {
    const auth = new AuthService({
      apiKeyStore: new ApiKeyStore([{ key: 'k1', subject: 'alice', roles: ['admin'] }]),
    });
    const principal = auth.authenticate('ApiKey', 'k1');
    assert.deepEqual(principal, { subject: 'alice', roles: ['admin'], authMethod: 'api-key' });
  });

  test('rejects a valid key sent under the wrong scheme', () => {
    const auth = new AuthService({
      apiKeyStore: new ApiKeyStore([{ key: 'k1', subject: 'alice', roles: ['admin'] }]),
    });
    assert.equal(auth.authenticate('Bearer', 'k1'), undefined);
  });
});

describe('AuthService: JWT authentication', () => {
  test('authenticates a valid JWT under the Bearer scheme', () => {
    const jwtService = new JwtService({ secret: 'shh' });
    const auth = new AuthService({ jwtService });
    const token = jwtService.sign('bob', ['viewer']);
    assert.deepEqual(auth.authenticate('Bearer', token), { subject: 'bob', roles: ['viewer'], authMethod: 'jwt' });
  });
});

describe('AuthService: authorization', () => {
  test('grants a permission the principal\'s roles include', () => {
    const auth = new AuthService();
    assert.equal(auth.authorize({ subject: 'alice', roles: ['admin'], authMethod: 'api-key' }, Permission.AgentWrite), true);
  });

  test('denies a permission the principal\'s roles do not include', () => {
    const auth = new AuthService();
    assert.equal(
      auth.authorize({ subject: 'bob', roles: ['viewer'], authMethod: 'api-key' }, Permission.AgentWrite),
      false,
    );
  });
});

describe('AuthService: diagnostics', () => {
  test('tracks attempts, successes, failures, and denials', () => {
    const auth = new AuthService({
      apiKeyStore: new ApiKeyStore([{ key: 'k1', subject: 'alice', roles: ['viewer'] }]),
    });

    auth.authenticate('ApiKey', 'k1');
    auth.authenticate('ApiKey', 'wrong-key');
    auth.authorize({ subject: 'alice', roles: ['viewer'], authMethod: 'api-key' }, Permission.AgentWrite);

    const diagnostics = auth.getDiagnostics();
    assert.equal(diagnostics.enabled, true);
    assert.equal(diagnostics.apiKeysConfigured, 1);
    assert.equal(diagnostics.jwtConfigured, false);
    assert.equal(diagnostics.authAttempts, 2);
    assert.equal(diagnostics.authSuccesses, 1);
    assert.equal(diagnostics.authFailures, 1);
    assert.equal(diagnostics.authorizationDenials, 1);
  });
});
