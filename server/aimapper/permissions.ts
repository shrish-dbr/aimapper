// Role → resource-permission plan for the Admin "Assign a role" flow.
//
// Pure (no I/O) so it can be unit-tested: given a role and the app's resource ids it
// returns the set of grants that role needs for the app to work, plus helpers for
// comparing permission levels and rebuilding an ACL without one principal. The
// executor in aimapper.ts applies the plan with the signed-in admin's identity and
// records what it actually granted in a ledger table, so revocation only undoes
// app-made grants.

export type AppRole = 'viewer' | 'editor' | 'admin';
export type PrincipalKind = 'user' | 'group';

/** A workspace-object permission set via the Permissions API. */
export interface AclGrant {
  kind: 'acl';
  /** Permissions API object type, e.g. 'apps', 'genie', 'serving-endpoints'. */
  objectType: string;
  objectId: string;
  level: string;
  label: string;
}

/** A Unity Catalog privilege set via SQL GRANT. */
export interface UcGrant {
  kind: 'uc';
  securable: 'CATALOG' | 'SCHEMA' | 'TABLE' | 'VOLUME';
  /** Fully-qualified securable name, unquoted (e.g. cat.schema.table). */
  name: string;
  privilege: string;
  label: string;
}

export type PlannedGrant = AclGrant | UcGrant;

export interface ResourceIds {
  catalog: string;
  schema: string;
  appName: string | null;
  warehouseId: string | null;
  genieSpaceId: string | null;
  vsEndpointId: string | null;
}

/** Ordered permission levels per object type (low → high), for "already has ≥" checks. */
export const LEVELS: Record<string, string[]> = {
  apps: ['CAN_USE', 'CAN_MANAGE'],
  genie: ['CAN_READ', 'CAN_RUN', 'CAN_EDIT', 'CAN_MANAGE'],
  'serving-endpoints': ['CAN_VIEW', 'CAN_QUERY', 'CAN_MANAGE'],
  warehouses: ['CAN_VIEW', 'CAN_MONITOR', 'CAN_USE', 'CAN_MANAGE', 'IS_OWNER'],
  'vector-search-endpoints': ['CAN_USE', 'CAN_MANAGE'],
};

/** True when `have` is at least `want` for this object type (unknown levels → false). */
export function levelCovers(objectType: string, have: string | null | undefined, want: string): boolean {
  if (!have) return false;
  const order = LEVELS[objectType] ?? [];
  const h = order.indexOf(have.toUpperCase());
  const w = order.indexOf(want.toUpperCase());
  return h >= 0 && w >= 0 && h >= w;
}

// Tables each role writes through the app (derived from the server routes).
export const VIEWER_WRITE_TABLES = ['aimapper_conversion_runs', 'aimapper_run_steps', 'aimapper_feedback', 'aimapper_user_prefs'];
export const EDITOR_WRITE_TABLES = [
  ...VIEWER_WRITE_TABLES,
  'mapping_examples',
  'aimapper_retrieval_corpus',
  'aimapper_projects',
  'aimapper_domain_instructions',
  // Uploading/deleting/re-syncing reference documents re-indexes their chunks.
  'aimapper_reference_chunks',
];
const REFERENCE_VOLUME = 'reference_docs';

/** The grants a role needs. Admins get manage-level access everywhere (so they can
 * in turn grant others); viewers/editors get the lowest level each feature needs. */
export function planGrants(role: AppRole, ids: ResourceIds): PlannedGrant[] {
  const admin = role === 'admin';
  const out: PlannedGrant[] = [];
  const acl = (objectType: string, objectId: string | null, level: string, label: string) => {
    if (objectId) out.push({ kind: 'acl', objectType, objectId, level, label });
  };
  acl('apps', ids.appName, admin ? 'CAN_MANAGE' : 'CAN_USE', 'AI Mapper app');
  acl('warehouses', ids.warehouseId, admin ? 'CAN_MANAGE' : 'CAN_USE', 'SQL warehouse');
  acl('genie', ids.genieSpaceId, admin ? 'CAN_MANAGE' : 'CAN_RUN', 'Genie space');
  acl('vector-search-endpoints', ids.vsEndpointId, admin ? 'CAN_MANAGE' : 'CAN_USE', 'Vector Search endpoint');

  const schemaFq = `${ids.catalog}.${ids.schema}`;
  const uc = (securable: UcGrant['securable'], name: string, privilege: string, label: string) =>
    out.push({ kind: 'uc', securable, name, privilege, label });
  uc('CATALOG', ids.catalog, 'USE CATALOG', `Catalog ${ids.catalog}`);
  if (admin) {
    uc('SCHEMA', schemaFq, 'ALL PRIVILEGES', `Schema ${schemaFq}`);
    uc('SCHEMA', schemaFq, 'MANAGE', `Schema ${schemaFq}`);
    return out;
  }
  uc('SCHEMA', schemaFq, 'USE SCHEMA', `Schema ${schemaFq}`);
  uc('SCHEMA', schemaFq, 'SELECT', `Schema ${schemaFq}`);
  uc('SCHEMA', schemaFq, 'READ VOLUME', `Schema ${schemaFq}`);
  for (const t of role === 'editor' ? EDITOR_WRITE_TABLES : VIEWER_WRITE_TABLES) {
    uc('TABLE', `${schemaFq}.${t}`, 'MODIFY', `Table ${t}`);
  }
  if (role === 'editor') uc('VOLUME', `${schemaFq}.${REFERENCE_VOLUME}`, 'WRITE VOLUME', `Volume ${REFERENCE_VOLUME}`);
  return out;
}

/** Ledger identity of a grant. ACLs are keyed per object (one level per principal);
 * UC grants per privilege. */
export function grantKey(g: { kind: string; objectType?: string; objectId?: string; securable?: string; name?: string; privilege?: string }): string {
  return g.kind === 'acl'
    ? `acl|${g.objectType}|${g.objectId}`
    : `uc|${g.securable}|${(g.name ?? '').toLowerCase()}|${(g.privilege ?? '').toUpperCase()}`;
}

/** Backtick-quote a SQL identifier part (principal or securable segment). */
export function quoteIdent(part: string): string {
  return '`' + part.replace(/`/g, '``') + '`';
}

/** Quote a dotted securable name: cat.schema.table → `cat`.`schema`.`table`. */
export function quoteSecurable(name: string): string {
  return name.split('.').map(quoteIdent).join('.');
}

export interface AclEntry {
  user_name?: string;
  group_name?: string;
  service_principal_name?: string;
  all_permissions?: { permission_level?: string; inherited?: boolean }[];
}

/** The principal's DIRECT (non-inherited) level on an ACL, or null. */
export function directLevel(acl: AclEntry[], principal: string, kind: PrincipalKind): string | null {
  const p = principal.toLowerCase();
  for (const e of acl) {
    const name = (kind === 'group' ? e.group_name : e.user_name)?.toLowerCase();
    if (name !== p) continue;
    const direct = (e.all_permissions ?? []).filter((x) => !x.inherited && x.permission_level);
    if (direct.length) return String(direct[direct.length - 1].permission_level);
  }
  return null;
}

/** The ACL's direct entries (for a full PUT), with `principal` removed or set to `level`. */
export function rebuildAcl(
  acl: AclEntry[],
  principal: string,
  kind: PrincipalKind,
  level: string | null,
): Record<string, string>[] {
  const p = principal.toLowerCase();
  const out: Record<string, string>[] = [];
  for (const e of acl) {
    const isTarget = (kind === 'group' ? e.group_name : e.user_name)?.toLowerCase() === p;
    if (isTarget) continue;
    for (const perm of e.all_permissions ?? []) {
      if (perm.inherited || !perm.permission_level) continue;
      const who: Record<string, string> = e.user_name
        ? { user_name: e.user_name }
        : e.group_name
          ? { group_name: e.group_name }
          : e.service_principal_name
            ? { service_principal_name: e.service_principal_name }
            : {};
      if (Object.keys(who).length) out.push({ ...who, permission_level: perm.permission_level });
    }
  }
  if (level) out.push({ [kind === 'group' ? 'group_name' : 'user_name']: principal, permission_level: level });
  return out;
}
