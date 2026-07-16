import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Permission } from './Permission.ts';
import { Role, permissionsForRoles } from './Role.ts';

describe('permissionsForRoles', () => {
  test('admin grants every permission', () => {
    const granted = permissionsForRoles([Role.Admin]);
    for (const permission of Object.values(Permission)) {
      assert.ok(granted.has(permission), `expected admin to grant ${permission}`);
    }
  });

  test('viewer grants read-only permissions, not write', () => {
    const granted = permissionsForRoles([Role.Viewer]);
    assert.ok(granted.has(Permission.AgentRead));
    assert.ok(!granted.has(Permission.AgentWrite));
    assert.ok(!granted.has(Permission.ChatWrite));
  });

  test('operator grants read+write for chat/agent/workflow but not diagnostics', () => {
    const granted = permissionsForRoles([Role.Operator]);
    assert.ok(granted.has(Permission.ChatWrite));
    assert.ok(granted.has(Permission.AgentWrite));
    assert.ok(granted.has(Permission.WorkflowWrite));
    assert.ok(!granted.has(Permission.DiagnosticsRead));
  });

  test('unions permissions across multiple roles', () => {
    const granted = permissionsForRoles([Role.Viewer, Role.Operator]);
    assert.ok(granted.has(Permission.DiagnosticsRead));
    assert.ok(granted.has(Permission.ChatWrite));
  });

  test('an unknown role grants nothing, silently', () => {
    const granted = permissionsForRoles(['not-a-real-role']);
    assert.equal(granted.size, 0);
  });

  test('an empty role list grants nothing', () => {
    assert.equal(permissionsForRoles([]).size, 0);
  });
});
