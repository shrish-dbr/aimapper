import { describe, it, expect } from 'vitest';
import {
  roleGroupsFromEnv,
  roleFromGroups,
  planMembershipChange,
  scimEq,
  memberKind,
  collapseMemberships,
  DEFAULT_ROLE_GROUPS,
} from '../server/aimapper/roleGroups.js';

describe('roleGroupsFromEnv', () => {
  it('defaults to the aimapper-* groups and honours overrides', () => {
    expect(roleGroupsFromEnv({})).toEqual(DEFAULT_ROLE_GROUPS);
    expect(roleGroupsFromEnv({ AIMAPPER_EDITOR_GROUP: ' mapping-editors ' }).editor).toBe('mapping-editors');
  });
});

describe('roleFromGroups', () => {
  it('returns the highest role group, case-insensitively, or null', () => {
    expect(roleFromGroups(['users', 'AIMAPPER-VIEWERS', 'aimapper-editors'], DEFAULT_ROLE_GROUPS)).toBe('editor');
    expect(roleFromGroups(['aimapper-viewers', 'aimapper-admins'], DEFAULT_ROLE_GROUPS)).toBe('admin');
    expect(roleFromGroups(['users', 'admins'], DEFAULT_ROLE_GROUPS)).toBeNull();
  });
});

describe('planMembershipChange', () => {
  it('moves a principal into exactly one role group', () => {
    expect(planMembershipChange(['viewer'], 'editor')).toEqual({ add: 'editor', remove: ['viewer'] });
    expect(planMembershipChange(['editor', 'admin'], 'editor')).toEqual({ add: null, remove: ['admin'] });
    expect(planMembershipChange([], 'admin')).toEqual({ add: 'admin', remove: [] });
  });
  it('removes from every role group when the role is cleared', () => {
    expect(planMembershipChange(['viewer', 'admin'], null)).toEqual({ add: null, remove: ['viewer', 'admin'] });
  });
});

describe('scimEq / memberKind', () => {
  it('escapes quotes in SCIM filters', () => {
    expect(scimEq('displayName', 'a "b" \\c')).toBe('displayName eq "a \\"b\\" \\\\c"');
  });
  it('classifies member refs', () => {
    expect(memberKind('Users/1')).toBe('user');
    expect(memberKind('Groups/2')).toBe('group');
    expect(memberKind('ServicePrincipals/3')).toBe('service_principal');
    expect(memberKind(undefined)).toBe('user');
  });
});

describe('collapseMemberships', () => {
  it('shows each principal once at its highest role, noting redundant memberships', () => {
    const out = collapseMemberships([
      { id: '1', kind: 'user', display: 'Bo', role: 'viewer' },
      { id: '1', kind: 'user', display: 'Bo', role: 'admin' },
      { id: '2', kind: 'group', display: 'Team', role: 'editor' },
    ]);
    expect(out).toEqual([
      { id: '1', kind: 'user', display: 'Bo', role: 'admin', alsoIn: ['viewer'] },
      { id: '2', kind: 'group', display: 'Team', role: 'editor', alsoIn: [] },
    ]);
  });
});
