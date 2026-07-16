export type AuthMethod = 'api-key' | 'jwt';

// The authenticated caller for one request: an identity plus the roles
// that decide what it's allowed to do (see Role.ts). Deliberately never
// carries the raw credential — that's checked once during authentication
// (ApiKeyStore.verify()/JwtService.verify()) and discarded immediately.
export interface Principal {
  readonly subject: string;
  readonly roles: readonly string[];
  readonly authMethod: AuthMethod;
}
