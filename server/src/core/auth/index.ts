// The auth API surface. Consumers import from this barrel only — the
// individual files are implementation layout.

export { AuthError } from './AuthError.ts';
export { Permission } from './Permission.ts';
export { Role, ROLE_PERMISSIONS, permissionsForRoles } from './Role.ts';
export type { AuthMethod, Principal } from './Principal.ts';
export { ApiKeyStore, parseApiKeyDefinitions } from './ApiKeyStore.ts';
export type { ApiKeyDefinition } from './ApiKeyStore.ts';
export { JwtService } from './JwtService.ts';
export type { JwtServiceOptions } from './JwtService.ts';
export { RateLimiter } from './RateLimiter.ts';
export type { RateLimiterOptions, RateLimitResult, RateLimiterDiagnostics } from './RateLimiter.ts';
export { AuthService } from './AuthService.ts';
export type { AuthServiceOptions, AuthServiceDiagnostics } from './AuthService.ts';
