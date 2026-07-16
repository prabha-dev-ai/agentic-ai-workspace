import { Permission } from './Permission.ts';

// Built-in roles and what each grants. A deployment configures which
// role(s) an API key or JWT maps to (ApiKeyStore/JwtService) — the roles
// themselves are a fixed, closed set rather than dynamically registrable,
// the same design choice MetricType/EventType already make for their own
// closed vocabularies.
export const Role = {
  Admin: 'admin',
  Operator: 'operator',
  Viewer: 'viewer',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

const ALL_PERMISSIONS = Object.values(Permission);

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  [Role.Admin]: ALL_PERMISSIONS,
  [Role.Operator]: [
    Permission.ChatWrite,
    Permission.AgentRead,
    Permission.AgentWrite,
    Permission.WorkflowRead,
    Permission.WorkflowWrite,
  ],
  [Role.Viewer]: [
    Permission.AgentRead,
    Permission.WorkflowRead,
    Permission.DiagnosticsRead,
    Permission.MetricsRead,
  ],
};

/** Unions the permissions granted by every role a principal holds.
 *  Unknown role strings (a typo in configuration, a stale JWT claim) are
 *  silently ignored rather than thrown — the same "malformed input grants
 *  nothing" default-deny posture RBAC needs, not a hard failure. */
export function permissionsForRoles(roles: readonly string[]): Set<Permission> {
  const permissions = new Set<Permission>();

  for (const role of roles) {
    const granted = ROLE_PERMISSIONS[role as Role];
    if (granted) {
      for (const permission of granted) {
        permissions.add(permission);
      }
    }
  }

  return permissions;
}
