import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthError } from './AuthError.ts';
import { JwtService } from './JwtService.ts';

describe('JwtService', () => {
  test('rejects an empty secret', () => {
    assert.throws(() => new JwtService({ secret: '' }), AuthError);
  });

  test('sign/verify round-trips subject and roles', () => {
    const service = new JwtService({ secret: 'shh' });
    const token = service.sign('alice', ['admin', 'viewer']);
    const principal = service.verify(token);
    assert.deepEqual(principal, { subject: 'alice', roles: ['admin', 'viewer'], authMethod: 'jwt' });
  });

  test('rejects a token signed with a different secret', () => {
    const signer = new JwtService({ secret: 'secret-a' });
    const verifier = new JwtService({ secret: 'secret-b' });
    const token = signer.sign('alice', ['admin']);
    assert.equal(verifier.verify(token), undefined);
  });

  test('rejects an expired token', () => {
    const service = new JwtService({ secret: 'shh' });
    const token = service.sign('alice', ['admin'], -10);
    assert.equal(service.verify(token), undefined);
  });

  test('rejects a token whose issuer does not match', () => {
    const signer = new JwtService({ secret: 'shh', issuer: 'issuer-a' });
    const verifier = new JwtService({ secret: 'shh', issuer: 'issuer-b' });
    const token = signer.sign('alice', ['admin']);
    assert.equal(verifier.verify(token), undefined);
  });

  test('accepts a token whose issuer matches', () => {
    const service = new JwtService({ secret: 'shh', issuer: 'gateway' });
    const token = service.sign('alice', ['admin']);
    assert.equal(service.verify(token)?.subject, 'alice');
  });

  test('rejects a malformed token', () => {
    const service = new JwtService({ secret: 'shh' });
    assert.equal(service.verify('not-a-jwt'), undefined);
    assert.equal(service.verify('a.b'), undefined);
    assert.equal(service.verify('a.b.c'), undefined);
  });

  test('rejects a tampered payload', () => {
    const service = new JwtService({ secret: 'shh' });
    const token = service.sign('alice', ['admin']);
    const [header, , signature] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'mallory', roles: ['admin'] })).toString('base64url');
    assert.equal(service.verify(`${header}.${tamperedPayload}.${signature}`), undefined);
  });
});
