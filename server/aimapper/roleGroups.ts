// Group-based roles. Each app role maps to one ACCOUNT group (aimapper-admins /
// aimapper-editors / aimapper-viewers by default). The groups hold every resource
// permission the role needs (granted once at setup — see "Apply group permissions" in
// Admin → Roles); assigning a role to someone just adds them to the group. A user's
// role is the highest role group they belong to, directly or through a nested group.
//
// Pure helpers only (no I/O) so they can be unit-tested.

export type GroupRole = 'viewer' | 'editor' | 'admin';

export const ROLE_ORDER: GroupRole[] = ['viewer', 'editor', 'admin'];
const RANK: Record<GroupRole, number> = { viewer: 0, editor: 1, admin: 2 };

export const DEFAULT_ROLE_GROUPS: Record<GroupRole, string> = {
  admin: 'aimapper-admins',
  editor: 'aimapper-editors',
  viewer: 'aimapper-viewers',
};

/** Role group names from env (AIMAPPER_ADMIN_GROUP / _EDITOR_GROUP / _VIEWER_GROUP). */
export function roleGroupsFromEnv(env: Record<string, string | undefined>): Record<GroupRole, string> {
  return {
    admin: env.AIMAPPER_ADMIN_GROUP?.trim() || DEFAULT_ROLE_GROUPS.admin,
    editor: env.AIMAPPER_EDITOR_GROUP?.trim() || DEFAULT_ROLE_GROUPS.editor,
    viewer: env.AIMAPPER_VIEWER_GROUP?.trim() || DEFAULT_ROLE_GROUPS.viewer,
  };
}

/** Highest role whose group appears in `groups` (case-insensitive), or null. */
export function roleFromGroups(groups: string[], roleGroups: Record<GroupRole, string>): GroupRole | null {
  const have = new Set(groups.map((g) => g.toLowerCase()));
  let best: GroupRole | null = null;
  for (const r of ROLE_ORDER) {
    if (have.has(roleGroups[r].toLowerCase()) && (best === null || RANK[r] > RANK[best])) best = r;
  }
  return best;
}

/** Which role groups to add the principal to / remove it from so it ends up in exactly
 * `target`'s group (target=null → remove from all). */
export function planMembershipChange(
  memberOf: GroupRole[],
  target: GroupRole | null,
): { add: GroupRole | null; remove: GroupRole[] } {
  const current = new Set(memberOf);
  return {
    add: target && !current.has(target) ? target : null,
    remove: ROLE_ORDER.filter((r) => current.has(r) && r !== target),
  };
}

/** SCIM filter `attr eq "value"` with the value's quotes/backslashes escaped. */
export function scimEq(attr: string, value: string): string {
  return `${attr} eq "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export type MemberKind = 'user' | 'group' | 'service_principal';

/** Kind of a SCIM group member from its $ref ("Users/123", "Groups/…", "ServicePrincipals/…"). */
export function memberKind(ref: string | undefined): MemberKind {
  const r = (ref ?? '').toLowerCase();
  if (r.startsWith('groups/')) return 'group';
  if (r.startsWith('serviceprincipals/')) return 'service_principal';
  return 'user';
}

export interface RoleMembership {
  id: string;
  kind: MemberKind;
  display: string;
  role: GroupRole;
}

/** One row per member with the highest role group they are in (a principal sitting in
 * several role groups is shown once, at its effective role). */
export function collapseMemberships(rows: RoleMembership[]): (RoleMembership & { alsoIn: GroupRole[] })[] {
  const byId = new Map<string, RoleMembership & { alsoIn: GroupRole[] }>();
  for (const m of rows) {
    const prev = byId.get(m.id);
    if (!prev) { byId.set(m.id, { ...m, alsoIn: [] }); continue; }
    if (RANK[m.role] > RANK[prev.role]) byId.set(m.id, { ...m, alsoIn: [...prev.alsoIn, prev.role] });
    else prev.alsoIn.push(m.role);
  }
  return [...byId.values()].sort((a, b) => RANK[b.role] - RANK[a.role] || a.display.localeCompare(b.display));
}
