import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthError } from './AuthError.ts';
import type { Principal } from './Principal.ts';

export interface JwtServiceOptions {
  secret: string;
  /** When set, tokens whose "iss" claim doesn't match exactly are rejected. */
  issuer?: string;
}

interface JwtClaims {
  sub?: string;
  roles?: string[] | string;
  iss?: string;
  exp?: number;
}

// A minimal HS256 JWT signer/verifier — hand-rolled with node:crypto
// rather than a dependency, the same "pure data-shaping, no library
// needed" reasoning as controllers/metricsFormat.ts's Prometheus
// formatter. Only HS256 is supported: this reference implementation signs
// and verifies with the same shared secret, not general-purpose interop
// with arbitrary external issuers or algorithms.
export class JwtService {
  private readonly secret: string;
  private readonly issuer: string | undefined;

  constructor(options: JwtServiceOptions) {
    if (options.secret.trim() === '') {
      throw new AuthError('JwtService needs a non-empty secret.');
    }
    this.secret = options.secret;
    this.issuer = options.issuer;
  }

  /** Mints a token for tooling/tests that need one — the gateway itself
   *  only ever verifies (there is no token-issuance HTTP endpoint in this
   *  story). */
  sign(subject: string, roles: readonly string[], expiresInSeconds = 3600): string {
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload: JwtClaims = {
      sub: subject,
      roles: [...roles],
      exp: now + expiresInSeconds,
      ...(this.issuer !== undefined ? { iss: this.issuer } : {}),
    };

    const encodedHeader = toBase64Url(JSON.stringify(header));
    const encodedPayload = toBase64Url(JSON.stringify(payload));
    const signature = this.computeSignature(`${encodedHeader}.${encodedPayload}`);

    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }

  /** Verifies signature, expiry, and (if configured) issuer. Returns
   *  undefined for anything invalid — never throws for untrusted input,
   *  the same failure-as-value posture ApiKeyStore.verify() takes. */
  verify(token: string): Principal | undefined {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return undefined;
    }
    const [encodedHeader, encodedPayload, signature] = parts;
    if (!encodedHeader || !encodedPayload || !signature) {
      return undefined;
    }

    const expectedSignature = this.computeSignature(`${encodedHeader}.${encodedPayload}`);
    if (!constantTimeEqual(signature, expectedSignature)) {
      return undefined;
    }

    let claims: JwtClaims;
    try {
      claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as JwtClaims;
    } catch {
      return undefined;
    }

    if (typeof claims.sub !== 'string' || claims.sub.trim() === '') {
      return undefined;
    }
    if (typeof claims.exp === 'number' && claims.exp < Math.floor(Date.now() / 1000)) {
      return undefined;
    }
    if (this.issuer !== undefined && claims.iss !== this.issuer) {
      return undefined;
    }

    const roles = Array.isArray(claims.roles)
      ? claims.roles
      : typeof claims.roles === 'string'
        ? claims.roles.split(',').map((role) => role.trim()).filter(Boolean)
        : [];

    return { subject: claims.sub, roles, authMethod: 'jwt' };
  }

  private computeSignature(data: string): string {
    return createHmac('sha256', this.secret).update(data).digest('base64url');
  }
}

function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
