import { ApiKeyStore } from './ApiKeyStore.ts';
import { JwtService } from './JwtService.ts';
import { permissionsForRoles } from './Role.ts';
import type { Permission } from './Permission.ts';
import type { Principal } from './Principal.ts';

export interface AuthServiceOptions {
  apiKeyStore?: ApiKeyStore;
  jwtService?: JwtService;
}

export interface AuthServiceDiagnostics {
  enabled: boolean;
  apiKeysConfigured: number;
  jwtConfigured: boolean;
  authAttempts: number;
  authSuccesses: number;
  authFailures: number;
  authorizationDenials: number;
}

// The gateway's authn/authz hub — mirrors SecurityService's shape
// deliberately (a hub other modules ask "is this allowed", not a state
// machine): authenticate() turns a raw credential into a Principal, or
// undefined for a bad one — it never throws for untrusted input, the same
// failure-as-value philosophy as CheckpointManager.recover(). authorize()
// checks a Principal's roles against the permission model in Role.ts.
//
// Disabled by default (no ApiKeyStore/JwtService configured): isEnabled()
// is false, and route-authorization middleware (middleware/authorize.middleware.ts)
// treats that as "let everything through" — a zero-config deployment
// behaves exactly like AAI-037, unchanged.
export class AuthService {
  private readonly apiKeyStore: ApiKeyStore | undefined;
  private readonly jwtService: JwtService | undefined;

  private authAttempts = 0;
  private authSuccesses = 0;
  private authFailures = 0;
  private authorizationDenials = 0;

  constructor(options: AuthServiceOptions = {}) {
    this.apiKeyStore = options.apiKeyStore;
    this.jwtService = options.jwtService;
  }

  /** Whether any credential source is configured. Route-authorization
   *  middleware becomes a no-op when this is false. */
  isEnabled(): boolean {
    return (this.apiKeyStore?.size ?? 0) > 0 || this.jwtService !== undefined;
  }

  /** `scheme` is the Authorization header's first token ("ApiKey" or
   *  "Bearer") — the only two this gateway accepts. Anything else, or a
   *  scheme whose backing store isn't configured, fails closed. */
  authenticate(scheme: string, credential: string): Principal | undefined {
    this.authAttempts++;

    let principal: Principal | undefined;
    if (scheme === 'ApiKey' && this.apiKeyStore) {
      principal = this.apiKeyStore.verify(credential);
    } else if (scheme === 'Bearer' && this.jwtService) {
      principal = this.jwtService.verify(credential);
    }

    if (principal) {
      this.authSuccesses++;
    } else {
      this.authFailures++;
    }

    return principal;
  }

  authorize(principal: Principal, permission: Permission): boolean {
    const granted = permissionsForRoles(principal.roles).has(permission);
    if (!granted) {
      this.authorizationDenials++;
    }
    return granted;
  }

  getDiagnostics(): AuthServiceDiagnostics {
    return {
      enabled: this.isEnabled(),
      apiKeysConfigured: this.apiKeyStore?.size ?? 0,
      jwtConfigured: this.jwtService !== undefined,
      authAttempts: this.authAttempts,
      authSuccesses: this.authSuccesses,
      authFailures: this.authFailures,
      authorizationDenials: this.authorizationDenials,
    };
  }
}
