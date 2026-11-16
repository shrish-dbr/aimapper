import { describe, it, expect } from 'vitest';
import {
  planGrants,
  grantKey,
  levelCovers,
  directLevel,
  rebuildAcl,
  quoteIdent,
  quoteSecurable,
  type ResourceIds,
  type AclEntry,
} from '../server/aimapper/permissions.js';

const IDS: ResourceIds = {
  catalog: 'cat',
  schema: 'aimapper',
  appName: 'aimapper',
  warehouseId: 'wh1',
  genieSpaceId: 'g1',
  kaEndpointId: 'ep1',
  kaId: 'ka1',
  vsEndpointId: 'vs1',
};

const acl = (role: 'viewer' | 'editor' | 'admin') =>
  Object.fromEntries(planGrants(role, IDS).filter((g) => g.kind === 'acl').map((g) => [g.kind === 'acl' ? g.objectType : '', g.kind === 'acl' ? g.level : '']));
const uc = (role: 'viewer' | 'editor' | 'admin') =>
  planGrants(role, IDS).filter((g) => g.kind === 'uc').map((g) => (g.kind === 'uc' ? `${g.securable} ${g.name} ${g.privilege}` : ''));

describe('planGrants', () => {
  it('gives viewers the minimum level each feature needs', () => {
    expect(acl('viewer')).toEqual({
      apps: 'CAN_USE',
      warehouses: 'CAN_USE',
      genie: 'CAN_RUN',
      'serving-endpoints': 'CAN_QUERY',
      'vector-search-endpoints': 'CAN_USE',
    });
    expect(uc('viewer')).toContain('SCHEMA cat.aimapper SELECT');
    expect(uc('viewer')).toContain('TABLE cat.aimapper.aimapper_conversion_runs MODIFY');
    expect(uc('viewer')).not.toContain('TABLE cat.aimapper.mapping_examples MODIFY');
    expect(uc('viewer').some((x) => x.includes('WRITE VOLUME'))).toBe(false);
  });

  it('adds curation writes for editors', () => {
    expect(acl('editor')).toEqual(acl('viewer'));
    expect(uc('editor')).toContain('TABLE cat.aimapper.mapping_examples MODIFY');
    expect(uc('editor')).toContain('VOLUME cat.aimapper.reference_docs WRITE VOLUME');
  });

  it('gives admins manage-level access everywhere, including the KA itself', () => {
    expect(Object.values(acl('admin')).every((l) => l === 'CAN_MANAGE')).toBe(true);
    expect(acl('admin')['knowledge-assistants']).toBe('CAN_MANAGE');
    expect(uc('admin')).toEqual(['CATALOG cat USE CATALOG', 'SCHEMA cat.aimapper ALL PRIVILEGES', 'SCHEMA cat.aimapper MANAGE']);
  });

  it('skips resources that are not configured', () => {
    const plan = planGrants('viewer', { ...IDS, genieSpaceId: null, kaEndpointId: null, vsEndpointId: null });
    const types = plan.filter((g) => g.kind === 'acl').map((g) => (g.kind === 'acl' ? g.objectType : ''));
    expect(types).toEqual(['apps', 'warehouses']);
  });

  it('keys ACL grants per object so a level change is an update, not a new grant', () => {
    const v = planGrants('viewer', IDS).find((g) => g.kind === 'acl' && g.objectType === 'apps')!;
    const a = planGrants('admin', IDS).find((g) => g.kind === 'acl' && g.objectType === 'apps')!;
    expect(grantKey(v)).toBe(grantKey(a));
  });
});

describe('levels and ACL helpers', () => {
  it('compares levels per object type', () => {
    expect(levelCovers('genie', 'CAN_MANAGE', 'CAN_RUN')).toBe(true);
    expect(levelCovers('genie', 'CAN_READ', 'CAN_RUN')).toBe(false);
    expect(levelCovers('apps', null, 'CAN_USE')).toBe(false);
  });

  const ACL: AclEntry[] = [
    { user_name: 'owner@x.com', all_permissions: [{ permission_level: 'IS_OWNER', inherited: false }] },
    { group_name: 'admins', all_permissions: [{ permission_level: 'CAN_MANAGE', inherited: true }] },
    { user_name: 'Jane@x.com', all_permissions: [{ permission_level: 'CAN_USE', inherited: false }] },
    { group_name: 'analysts', all_permissions: [{ permission_level: 'CAN_USE', inherited: false }] },
  ];

  it('reads a principal’s direct level case-insensitively', () => {
    expect(directLevel(ACL, 'jane@x.com', 'user')).toBe('CAN_USE');
    expect(directLevel(ACL, 'admins', 'group')).toBeNull(); // inherited only
  });

  it('rebuilds the ACL without the principal, keeping other direct entries and dropping inherited ones', () => {
    expect(rebuildAcl(ACL, 'jane@x.com', 'user', null)).toEqual([
      { user_name: 'owner@x.com', permission_level: 'IS_OWNER' },
      { group_name: 'analysts', permission_level: 'CAN_USE' },
    ]);
  });

  it('can set the principal to a specific level (restore / downgrade)', () => {
    const out = rebuildAcl(ACL, 'analysts', 'group', 'CAN_MANAGE');
    expect(out).toContainEqual({ group_name: 'analysts', permission_level: 'CAN_MANAGE' });
    expect(out.filter((e) => e.group_name === 'analysts')).toHaveLength(1);
  });

  it('quotes identifiers safely', () => {
    expect(quoteIdent('a`b')).toBe('`a``b`');
    expect(quoteSecurable('cat.sch.tbl')).toBe('`cat`.`sch`.`tbl`');
  });
});
