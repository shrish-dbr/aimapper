// AI Mapper plugin: custom routes for cascading UC discovery (OBO), target-driven
// LLM attribute discovery, multi-table JOIN SQL generation, dry-run validation
// against the target schema, run history, and a few-shot example (References) store.
//
// All Unity Catalog / target-schema / history / example table identifiers are env-driven
// (AIMAPPER_CATALOG / AIMAPPER_SCHEMA) so the app is workspace-agnostic.
//
// OBO: asUser(req) returns a proxy that runs proxied method calls inside the
// user's context (AsyncLocalStorage). So every handler runs its work via
// `this.asUser(req).inUserScope(fn)` — inside fn, getExecutionContext() returns
// the USER context and all statements execute on-behalf-of the signed-in user.
import { Plugin, toPlugin, getExecutionContext, type IAppRouter, type PluginManifest } from '@databricks/appkit';
import { WorkspaceClient } from '@databricks/sdk-experimental';
import type { Request as IAppRequest, Response as IAppResponse } from 'express';
import manifest from './manifest.json';
import {
  buildAttributeMatchPrompt,
  buildJoinSqlPrompt,
  cleanSql,
  extractJson,
  isReadOnlySql,
  CONFIDENCE_THRESHOLD,
  resolvePromptProfile,
  DEFAULT_PROMPT_PROFILE,
  PROMPT_PROFILES,
  type PromptLimits,
  type PromptProfile,
  annotateCompositeRationale,
} from './prompts.js';
import {
  DISCOVERY_BATCH_CHARS,
  DISCOVERY_CONCURRENCY,
  MAX_DISCOVERY_BATCHES,
  MAX_DISCOVERY_TABLES,
  batchSourceTables,
  mapWithConcurrency,
  mergeBatchMappings,
  rankSourceTables,
  type CandidateMapping,
} from './sourceSelection.js';
import { buildSampleContext } from './dataSampling.js'; // [DATA-SAMPLING] remove file + this import to drop the feature
import { buildReport, diffSchema, type ResultColumn } from './validate.js';
import { describeTargetSchemaField, resolveTargetSchemaColumns, rowsToTargetEntities } from './targetSchema.js';
import { resolveTransition, stampsReviewer, type ApprovalAction } from './approval.js';
import {
  planGrants,
  grantKey,
  levelCovers,
  directLevel,
  rebuildAcl,
  quoteIdent,
  quoteSecurable,
  type AclEntry,
  type PlannedGrant,
  type PrincipalKind,
} from './permissions.js';
import {
  buildReferenceChunkSql,
  buildReferenceQueries,
  packReferenceChunks,
  type ReferenceChunk,
  type ReferenceSource,
} from './references.js';
import {
  roleGroupsFromEnv,
  roleFromGroups,
  planMembershipChange,
  scimEq,
  memberKind,
  collapseMemberships,
  ROLE_ORDER,
  type RoleMembership,
} from './roleGroups.js';
import type {
  AttributeMapping,
  MappingExample,
  TargetEntity,
  RunItem,
  SourceColumn,
  SourceTable,
  TokenUsage,
} from './types.js';

const CATALOG = process.env.AIMAPPER_CATALOG ?? '';
const SCHEMA = process.env.AIMAPPER_SCHEMA ?? 'aimapper';
// The app's own tables live in the configured catalog/schema.
const DEFAULT_TARGET_SCHEMA_TABLE = `${CATALOG}.${SCHEMA}.target_schema`;
const HISTORY_TABLE = `${CATALOG}.${SCHEMA}.aimapper_conversion_runs`;
const EXAMPLES_TABLE = `${CATALOG}.${SCHEMA}.mapping_examples`;
const CONFIG_TABLE = `${CATALOG}.${SCHEMA}.aimapper_config`;
const FEEDBACK_TABLE = `${CATALOG}.${SCHEMA}.aimapper_feedback`;
const ROLES_TABLE = `${CATALOG}.${SCHEMA}.aimapper_roles`;
// Ledger of resource permissions the app granted on an admin's behalf, so removing or
// lowering a role revokes only app-made grants (see permissions.ts).
const GRANTS_LEDGER_TABLE = `${CATALOG}.${SCHEMA}.aimapper_permission_grants`;
const ACL_LABELS: Record<string, string> = {
  apps: 'AI Mapper app',
  warehouses: 'SQL warehouse',
  genie: 'Genie space',
  'vector-search-endpoints': 'Vector Search endpoint',
};
const USER_PREFS_TABLE = `${CATALOG}.${SCHEMA}.aimapper_user_prefs`;
// Source System = the EHR system TYPE a mapping's source data belongs to (Epic,
// Cerner…). Physical table/column names keep the legacy `domain` name on disk (no
// risky column-mapping migration / VS index rebuild); every code, API, and UI
// reference is "Source System".
const SOURCE_SYSTEMS_TABLE = `${CATALOG}.${SCHEMA}.aimapper_domains`;
// Per-source-system, admin/editor-authored natural-language instructions injected
// into the identify + generate prompts to steer mapping behavior for that EHR system.
const SOURCE_SYSTEM_INSTRUCTIONS_TABLE = `${CATALOG}.${SCHEMA}.aimapper_domain_instructions`;
// Every run/example belongs to one source system; unset/legacy rows are treated as
// the DEFAULT source system. Which one is default is fixed (is_default in the
// source-systems table); its name can be edited, so the name is loaded from the table
// on each request (cached) — 'Epic' is only the initial seed / fallback.
let DEFAULT_SOURCE_SYSTEM = 'Epic';

// A Project is the instance-level scope (e.g. two separate Epic installations map to
// two projects). One source system per project; every mapping in the project inherits
// it. Runs/examples/feedback/corpus are scoped by project_id.
const PROJECTS_TABLE = `${CATALOG}.${SCHEMA}.aimapper_projects`;
// Vendors — the EHR vendor a project's source data comes from (name + unique code +
// description), managed in Admin and selectable when creating a project.
const VENDORS_TABLE = `${CATALOG}.${SCHEMA}.aimapper_vendors`;
// target-schema versions — each is a labelled pointer to a target-schema table (with a
// description). One is the default; the Mapper picks a version per session and every
// target reference (targets list, contracts) follows it.
const SCHEMA_VERSIONS_TABLE = `${CATALOG}.${SCHEMA}.aimapper_schema_versions`;
const DEFAULT_SCHEMA_VERSION_ID = 'default';

/** Deterministic id of the per-source-system default project that legacy rows (no
 * project_id) belong to. Keeps backfill idempotent and lets filters treat a NULL
 * project_id as "this source system's default project". */
function defaultProjectId(sourceSystem: string | null | undefined): string {
  return `default::${((sourceSystem ?? '').trim() || DEFAULT_SOURCE_SYSTEM).toLowerCase()}`;
}

// ---- Vector Search retrieval (semantic few-shot at scale) ------------------
// Corpus table unions approved mapping_examples + approved history runs into one
// text-per-row corpus; a Delta Sync VS index embeds it. OPTIONAL — with no VS
// endpoint/index configured, generation falls back to the lexical retrieval
// (recency-50 + column-token overlap) so behavior is unchanged.
const CORPUS_TABLE = `${CATALOG}.${SCHEMA}.aimapper_retrieval_corpus`;
// Admin key/value settings (e.g. the Prompt Sizing profile). Generic so new
// global toggles don't each need their own column/table.
const SETTINGS_TABLE = `${CATALOG}.${SCHEMA}.aimapper_settings`;
const STEP_LOG_TABLE = `${CATALOG}.${SCHEMA}.aimapper_run_steps`;
const VS_ENDPOINT = process.env.AIMAPPER_VS_ENDPOINT ?? '';
const VS_INDEX = process.env.AIMAPPER_VS_INDEX ?? '';
// Few-shot retrieval sizing. Rather than a fixed top-3, include ALL relevant
// items (hard-filtered by domain+target, semantically ranked) — but stay bounded
// so the prompt never overruns the context window / the Apps ~120s proxy timeout:
//   - keep items whose similarity score ≥ RELEVANCE_THRESHOLD (semantic path only),
//   - pack them newest/most-similar first up to FEWSHOT_CHAR_BUDGET total chars,
//   - never exceed MAX_FEWSHOT_ITEMS.
const MAX_FEWSHOT_ITEMS = 20;
const FEWSHOT_CHAR_BUDGET = 200000; // ~50k tokens; holds one full large example (up to ~200k chars) or several smaller ones. Bounded overall by MAX_PROMPT_CHARS. The packer always keeps the top-ranked example (see retrieveExamples), so the best match is injected in full even if it alone fills the budget.
// Parallel Unity Catalog tables.get calls when loading source-table schemas.
const SOURCE_SCHEMA_CONCURRENCY = 8;
const RELEVANCE_THRESHOLD = 0.6;   // vector_search cosine-ish score floor
// Ceiling on candidates pulled from the index before threshold/budget trimming.
const VS_CANDIDATE_FETCH = 100;
// TTL for the process-level read cache of global, read-mostly config (target contract,
// source systems). Writers invalidate explicitly; this bounds staleness otherwise.
const READ_CACHE_TTL_MS = 60_000;
// Shorter TTL for the projects overview: it embeds live history rollups (run counts,
// review backlog), so cap staleness lower. Invalidated on project create/update/delete.
const PROJECTS_CACHE_TTL_MS = 30_000;
// Prompt-size guard for generation (~4 chars/token) is now set per Prompt Sizing
// profile (see PROMPT_PROFILES in prompts.ts): the generate handler trims optional
// blocks (data samples, then few-shot) until the assembled prompt fits lim.maxPromptChars.

// ---- Reference-document grounding (Vector Search over parsed PDF chunks) -----
// OPTIONAL: with AIMAPPER_DOCS_INDEX unset, mappings simply aren't doc-grounded.
//   DOCS_VOLUME — the UC volume reference PDFs are uploaded to (one folder per source system).
const GENIE_SPACE_ID = process.env.AIMAPPER_GENIE_SPACE_ID ?? '';
const DOCS_VOLUME = `/Volumes/${CATALOG}/${SCHEMA}/reference_docs`;
const DOCS_INDEX = process.env.AIMAPPER_DOCS_INDEX ?? '';
const REFERENCE_CHUNKS_TABLE = `${CATALOG}.${SCHEMA}.aimapper_reference_chunks`;
/** Nearest chunks fetched per retrieval query (before source-system filter + packing). */
const REFERENCE_FETCH_PER_QUERY = 25;
// Cap the grounding text injected into a prompt so it stays well within the
// model context / the Apps ~120s proxy timeout.
const MAX_REFERENCE_CONTEXT_CHARS = 20000; // fallback; Prompt Sizing profiles set 10k/20k/30k

// ---- roles & approval workflow (features 5) --------------------------------
// Three personas: viewer (generate SQL + submit for review), editor (+ approve/
// reject), admin (everything, incl. role management & delete). Each role is an
// ACCOUNT group (ROLE_GROUPS) that holds the role's resource permissions; a user's
// role is the highest role group they belong to (directly or via a nested group).
// Users in no role group default to 'viewer'. ROLES_TABLE is only an audit log of
// in-app membership changes. Bootstrap admins via AIMAPPER_ADMINS (comma-separated
// emails) so the very first login can manage everyone else.
type Role = 'viewer' | 'editor' | 'admin';
const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
function isRole(v: string): v is Role {
  return v === 'viewer' || v === 'editor' || v === 'admin';
}
const ROLE_GROUPS: Record<Role, string> = roleGroupsFromEnv(process.env);
const BOOTSTRAP_ADMINS = new Set(
  (process.env.AIMAPPER_ADMINS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/** Thrown by role guards; mapped to HTTP 403 by the route wrapper. */
class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * How few-shot retrieval is scoped for one generation.
 *  - crossProject=false (default): only the current project's approved examples/history.
 *  - crossProject=true ("Cross-Project Learning"): all projects of the SAME source
 *    system (reusing a prior Epic project's mappings for a new Epic project is useful;
 *    pulling Cerner SQL into an Epic mapping is not).
 * Legacy rows with a NULL project_id fold into their source system's default project.
 */
interface RetrievalScope {
  sourceSystem: string;
  projectId: string;
  crossProject: boolean;
}

export class AiMapper extends Plugin {
  static manifest = manifest as PluginManifest<'aimapper'>;

  /**
   * Entry point invoked as `this.asUser(req).inUserScope(fn)`. Because the asUser
   * proxy wraps this method in runInUserContext, every getExecutionContext() call
   * inside `fn` returns the USER (OBO) context.
   */
  async inUserScope<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  // ---- context helpers (only correct inside an inUserScope run) -----------
  private ctx() {
    return getExecutionContext();
  }

  private assertCatalog(): void {
    if (!CATALOG) {
      throw new Error(
        'AIMAPPER_CATALOG is not set. Set the `catalog` bundle variable (see databricks.yml) ' +
          'to your Unity Catalog catalog before deploying.',
      );
    }
  }

  private warehouseId(): string {
    const id = process.env.DATABRICKS_WAREHOUSE_ID;
    if (!id) throw new Error('DATABRICKS_WAREHOUSE_ID is not set');
    return id;
  }

  private currentUser(): string {
    const ctx = this.ctx();
    if ('userEmail' in ctx && ctx.userEmail) return ctx.userEmail;
    if ('userName' in ctx && ctx.userName) return ctx.userName;
    if ('userId' in ctx && ctx.userId) return ctx.userId;
    return 'unknown';
  }

  // ---- lightweight read cache --------------------------------------------
  // Process-level TTL cache for GLOBAL, read-mostly config (target contract, source
  // systems). These tables are app configuration every user reads, so caching them
  // process-wide is safe (unlike per-user data such as roles/prefs, which is never
  // cached here). Writers call invalidate() so admin changes show immediately; the
  // TTL is a backstop (and bounds staleness on a second replica, which invalidate
  // can't reach). Not for per-user or fast-changing data.
  private readCache = new Map<string, { at: number; val: unknown }>();
  private async cachedRead<T>(key: string, fn: () => Promise<T>, ttlMs: number = READ_CACHE_TTL_MS): Promise<T> {
    const hit = this.readCache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.val as T;
    const val = await fn();
    this.readCache.set(key, { at: Date.now(), val });
    return val;
  }
  /** Drop every cache entry whose key starts with `prefix` (call on the matching write). */
  private invalidateCache(prefix: string): void {
    for (const k of [...this.readCache.keys()]) if (k.startsWith(prefix)) this.readCache.delete(k);
  }


  // ---- role → resource permissions ----------------------------------------
  // When an admin assigns/changes/removes a role, grant (or revoke) the access that
  // role needs on the app's resources. Everything runs with the SIGNED-IN ADMIN's OBO
  // identity, so grants are made and audited as them and need their own authority.
  // Only grants the app actually made are recorded (and therefore ever revoked).

  private grantsLedgerEnsured = false;
  private async ensureGrantsLedger(): Promise<void> {
    if (this.grantsLedgerEnsured) return;
    await this.execStatement(
      `CREATE TABLE IF NOT EXISTS ${GRANTS_LEDGER_TABLE} (
         principal STRING NOT NULL COMMENT 'User email or group display name',
         principal_type STRING NOT NULL COMMENT 'user | group',
         grant_key STRING NOT NULL COMMENT 'acl|<objectType>|<id> or uc|<securable>|<name>|<privilege>',
         kind STRING NOT NULL COMMENT 'acl | uc',
         object_type STRING COMMENT 'Permissions API object type or UC securable type',
         object_id STRING COMMENT 'Object id or fully-qualified UC name',
         privilege STRING COMMENT 'Granted permission level / UC privilege',
         prior_level STRING COMMENT 'ACL only: principal''s direct level before the app changed it (NULL = none)',
         granted_by STRING, granted_at TIMESTAMP
       ) USING DELTA COMMENT 'Resource permissions granted by AI Mapper role assignments'`,
    );
    this.grantsLedgerEnsured = true;
  }

  /** Ids of the app's resources for the permission plan. Endpoint ids are looked up
   * by name (the Permissions API keys serving / vector-search endpoints by id). */
  private async resourceIds() {
    const client = this.ctx().client;
    const lookupId = async (path: string): Promise<string | null> => {
      try {
        const r = (await client.apiClient.request({ path, method: 'GET', headers: new Headers(), raw: false })) as { id?: string; endpoint?: { id?: string } } | null;
        return r?.id ?? r?.endpoint?.id ?? null;
      } catch {
        return null;
      }
    };
    return {
      catalog: CATALOG,
      schema: SCHEMA,
      appName: process.env.DATABRICKS_APP_NAME ?? null,
      warehouseId: process.env.DATABRICKS_WAREHOUSE_ID ?? null,
      genieSpaceId: GENIE_SPACE_ID || null,
      vsEndpointId: VS_ENDPOINT ? await lookupId(`/api/2.0/vector-search/endpoints/${encodeURIComponent(VS_ENDPOINT)}`) : null,
    };
  }

  private async getAcl(objectType: string, objectId: string): Promise<AclEntry[]> {
    const r = (await this.ctx().client.apiClient.request({
      path: `/api/2.0/permissions/${objectType}/${encodeURIComponent(objectId)}`,
      method: 'GET',
      headers: new Headers(),
      raw: false,
    })) as { access_control_list?: AclEntry[] } | null;
    return r?.access_control_list ?? [];
  }

  /** Set (or with level=null, remove) a principal's DIRECT level on an object, then
   * re-read the ACL to confirm it landed. Uses GET + full PUT because the SDK drops
   * PATCH request bodies; the PUT keeps every other direct entry intact. */
  private async setAclLevel(objectType: string, objectId: string, principal: string, kind: PrincipalKind, level: string | null): Promise<void> {
    const acl = await this.getAcl(objectType, objectId);
    await this.putAcl(objectType, objectId, rebuildAcl(acl, principal, kind, level));
    const after = directLevel(await this.getAcl(objectType, objectId), principal, kind);
    if ((after ?? null) !== (level ?? null)) {
      throw new Error(`Permission change did not take effect (now ${after ?? 'none'}, expected ${level ?? 'none'}).`);
    }
  }

  private async putAcl(objectType: string, objectId: string, list: Record<string, string>[]): Promise<void> {
    await this.ctx().client.apiClient.request({
      path: `/api/2.0/permissions/${objectType}/${encodeURIComponent(objectId)}`,
      method: 'PUT',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      raw: false,
      payload: { access_control_list: list },
    });
  }

  /** Run a GRANT/REVOKE/SHOW statement, throwing on failure. */
  private async ucStatement(sql: string): Promise<Record<string, string | null>[]> {
    return this.runQuery(sql);
  }

  /** Does `principal` already hold `privilege` DIRECTLY on the securable? */
  private async ucHasPrivilege(principal: string, securable: string, name: string, privilege: string): Promise<boolean> {
    const rows = await this.ucStatement(`SHOW GRANTS ${quoteIdent(principal)} ON ${securable} ${quoteSecurable(name)}`);
    const want = privilege.toUpperCase();
    return rows.some((r) => {
      const action = String(r.ActionType ?? r.action_type ?? r.privilege ?? '').toUpperCase();
      const objKey = String(r.ObjectKey ?? r.object_key ?? '').toLowerCase().replace(/`/g, '');
      const onThis = !objKey || objKey === name.toLowerCase();
      // ALL PRIVILEGES implies every privilege except MANAGE (UC grants MANAGE separately).
      return onThis && (action === want || (action === 'ALL PRIVILEGES' && want !== 'MANAGE'));
    });
  }

  /** Reconcile a principal's app-granted permissions with what `role` needs (null =
   * role removed → revoke everything the app granted them). Never throws; returns a
   * per-resource outcome list for the Admin UI. */
  private async syncRolePermissions(
    principal: string,
    kind: PrincipalKind,
    role: Role | null,
  ): Promise<{ resource: string; access: string; status: 'granted' | 'already' | 'revoked' | 'restored' | 'skipped' | 'failed'; detail?: string }[]> {
    const results: { resource: string; access: string; status: 'granted' | 'already' | 'revoked' | 'restored' | 'skipped' | 'failed'; detail?: string }[] = [];
    const me = this.currentUser();
    try {
      await this.ensureGrantsLedger();
    } catch (e) {
      return [{ resource: 'Permission ledger', access: '—', status: 'failed', detail: errMsg(e) }];
    }
    const ids = await this.resourceIds();
    // Unity Catalog only accepts account-level principals; workspace-local groups can
    // receive workspace permissions (app, Genie, …) but no UC grants.
    const workspaceLocal = kind === 'group' && (await this.isWorkspaceLocalGroup(principal));
    const planned: PlannedGrant[] = role ? planGrants(role, ids) : [];
    // An endpoint the app couldn't look up is left out of the plan — say so rather than
    // silently skipping it. The installer grants endpoint access to the role GROUPS only.
    const vsLookupFailed = !!(role && VS_ENDPOINT && !ids.vsEndpointId);
    if (vsLookupFailed) {
      results.push({
        resource: 'Vector Search endpoint',
        access: role === 'admin' ? 'CAN_MANAGE' : 'CAN_USE',
        status: 'skipped',
        detail:
          kind === 'group'
            ? `Couldn't look up endpoint ${VS_ENDPOINT} with your sign-in — the installer (setup/install.py) grants the role groups this.`
            : `Couldn't look up endpoint ${VS_ENDPOINT} with your sign-in — grant it in Compute → Vector Search, or assign the role through its group.`,
      });
    }
    const desired = workspaceLocal ? planned.filter((g) => g.kind === 'acl') : planned;
    if (workspaceLocal) {
      for (const g of planned.filter((x) => x.kind === 'uc')) {
        results.push({
          resource: g.label,
          access: g.kind === 'uc' ? g.privilege : '',
          status: 'skipped',
          detail: 'Workspace-local group — Unity Catalog only accepts account-level groups. Use an account group, or grant data access separately.',
        });
      }
    }
    const ledger = await this.runQuery(
      `SELECT grant_key, kind, object_type, object_id, privilege, prior_level FROM ${GRANTS_LEDGER_TABLE}
       WHERE lower(principal) = ${q(principal.toLowerCase())} AND principal_type = ${q(kind)}`,
    ).catch(() => [] as Record<string, string | null>[]);
    const desiredKeys = new Set(desired.map(grantKey));
    // Only rows that stay relevant (still desired) count as app-owned in the grant pass.
    const ledgerByKey = new Map(ledger.filter((r) => desiredKeys.has(String(r.grant_key))).map((r) => [String(r.grant_key), r]));

    const record = async (g: PlannedGrant, priorLevel: string | null) => {
      const key = grantKey(g);
      await this.execStatement(`DELETE FROM ${GRANTS_LEDGER_TABLE} WHERE lower(principal) = ${q(principal.toLowerCase())} AND principal_type = ${q(kind)} AND grant_key = ${q(key)}`);
      await this.execStatement(
        `INSERT INTO ${GRANTS_LEDGER_TABLE} (principal, principal_type, grant_key, kind, object_type, object_id, privilege, prior_level, granted_by, granted_at)
         VALUES (${q(principal)}, ${q(kind)}, ${q(key)}, ${q(g.kind)}, ${q(g.kind === 'acl' ? g.objectType : g.securable)}, ${q(g.kind === 'acl' ? g.objectId : g.name)}, ${q(g.kind === 'acl' ? g.level : g.privilege)}, ${q(priorLevel)}, ${q(me)}, CURRENT_TIMESTAMP())`,
      );
    };
    const forget = async (key: string) => {
      await this.execStatement(`DELETE FROM ${GRANTS_LEDGER_TABLE} WHERE lower(principal) = ${q(principal.toLowerCase())} AND principal_type = ${q(kind)} AND grant_key = ${q(key)}`);
    };

    // 1. Revoke app-made grants the role no longer needs FIRST — so e.g. lowering an
    //    admin doesn't see their (about to be revoked) ALL PRIVILEGES as "already has
    //    USE SCHEMA" and end up with nothing.
    for (const row of ledger) {
      const key = String(row.grant_key);
      if (desiredKeys.has(key)) continue;
      // The endpoint is missing from the plan only because its lookup failed, not because
      // the role no longer needs it — keep the existing grant.
      if (vsLookupFailed && row.kind === 'acl' && String(row.object_type ?? '') === 'vector-search-endpoints') continue;
      const objectType = String(row.object_type ?? '');
      const objectId = String(row.object_id ?? '');
      const privilege = String(row.privilege ?? '');
      const label = row.kind === 'acl' ? (ACL_LABELS[objectType] ?? objectType) : `${objectType.charAt(0) + objectType.slice(1).toLowerCase()} ${objectId}`;
      try {
        if (row.kind === 'acl') {
          const priorLevel = row.prior_level ? String(row.prior_level) : null;
          await this.setAclLevel(objectType, objectId, principal, kind, priorLevel);
          results.push({ resource: label, access: privilege, status: priorLevel ? 'restored' : 'revoked', detail: priorLevel ? `back to ${priorLevel}` : undefined });
        } else {
          await this.ucStatement(`REVOKE ${privilege} ON ${objectType} ${quoteSecurable(objectId)} FROM ${quoteIdent(principal)}`);
          results.push({ resource: label, access: privilege, status: 'revoked' });
        }
        await forget(key);
      } catch (e) {
        results.push({ resource: label, access: privilege, status: 'failed', detail: errMsg(e) });
      }
    }
    // 2. Grant what the role needs.
    for (const g of desired) {
      const key = grantKey(g);
      const prior = ledgerByKey.get(key);
      try {
        if (g.kind === 'acl') {
          const current = directLevel(await this.getAcl(g.objectType, g.objectId), principal, kind);
          const appOwned = !!prior;
          if (levelCovers(g.objectType, current, g.level) && (!appOwned || current === g.level)) {
            results.push({ resource: g.label, access: g.level, status: 'already' });
            continue;
          }
          // Covers both raising a level and lowering an app-granted one (admin → editor).
          await this.setAclLevel(g.objectType, g.objectId, principal, kind, g.level);
          // Keep the ORIGINAL pre-app level across changes so a later revoke restores it.
          await record(g, appOwned ? (prior.prior_level ?? null) : current);
          results.push({ resource: g.label, access: g.level, status: 'granted' });
        } else {
          if (prior) { results.push({ resource: g.label, access: g.privilege, status: 'already' }); continue; }
          if (await this.ucHasPrivilege(principal, g.securable, g.name, g.privilege)) {
            results.push({ resource: g.label, access: g.privilege, status: 'already' });
            continue;
          }
          await this.ucStatement(`GRANT ${g.privilege} ON ${g.securable} ${quoteSecurable(g.name)} TO ${quoteIdent(principal)}`);
          await record(g, null);
          results.push({ resource: g.label, access: g.privilege, status: 'granted' });
        }
      } catch (e) {
        // App + Genie ACLs need the `access-management` scope, which apps can't request —
        // setup/install.py sets those two with the admin's CLI login instead.
        if (missingScope(errMsg(e)) === 'access-management') {
          results.push({ resource: g.label, access: g.kind === 'acl' ? g.level : g.privilege, status: 'skipped', detail: 'Set by the installer, setup/install.py (an app sign-in can’t change this permission).' });
          continue;
        }
        results.push({ resource: g.label, access: g.kind === 'acl' ? g.level : g.privilege, status: 'failed', detail: errMsg(e) });
      }
    }

    for (const r of results.filter((x) => x.status === 'failed')) {
      console.warn(`[aimapper] permission sync for ${kind} ${principal}: ${r.resource} ${r.access} failed: ${r.detail ?? ''}`);
    }
    return results;
  }

  // ---- per-user preferences ----------------------------------------------
  /** Ensure the per-user prefs table exists (one row per user_email). Idempotent. */
  private userPrefsTableEnsured = false;
  private async ensureUserPrefsTable(): Promise<void> {
    if (this.userPrefsTableEnsured) return;
    await this.execStatement(
      `CREATE TABLE IF NOT EXISTS ${USER_PREFS_TABLE} (
         user_email STRING NOT NULL,
         default_endpoint STRING, default_catalog STRING, default_schema STRING,
         default_target STRING, theme STRING,
         updated_at TIMESTAMP
       ) USING DELTA`,
    );
    this.userPrefsTableEnsured = true;
  }

  // ---- source systems (EHR system types) ---------------------------------
  /** Ensure the source-systems table exists and is seeded with the defaults.
   * Idempotent. (Physical table is still named aimapper_domains on disk.) */
  private sourceSystemsTableEnsured = false;
  private async ensureSourceSystemsTable(): Promise<void> {
    if (this.sourceSystemsTableEnsured) return;
    await this.execStatement(
      `CREATE TABLE IF NOT EXISTS ${SOURCE_SYSTEMS_TABLE} (
         name STRING NOT NULL, description STRING, created_by STRING, created_at TIMESTAMP,
         is_default BOOLEAN COMMENT 'Exactly one row: the fallback source system (fixed; its name is editable)'
       ) USING DELTA`,
    );
    try {
      const cols = await this.runQuery(`DESCRIBE TABLE ${SOURCE_SYSTEMS_TABLE}`);
      if (!cols.some((c) => String(c.col_name ?? '').toLowerCase() === 'is_default')) {
        await this.execStatement(`ALTER TABLE ${SOURCE_SYSTEMS_TABLE} ADD COLUMNS (is_default BOOLEAN COMMENT 'Exactly one row: the fallback source system (fixed; its name is editable)')`);
      }
    } catch { /* best-effort */ }
    // Seed only an EMPTY table — seeding by name would resurrect a renamed default.
    await this.execStatement(
      `INSERT INTO ${SOURCE_SYSTEMS_TABLE} (name, description, created_by, created_at, is_default)
       SELECT * FROM VALUES ('Epic', 'Seeded default source system', 'system', CURRENT_TIMESTAMP(), true),
                            ('Cerner', 'Seeded default source system', 'system', CURRENT_TIMESTAMP(), false)
       WHERE NOT EXISTS (SELECT 1 FROM ${SOURCE_SYSTEMS_TABLE})`,
    );
    // Mark a default once (pre-flag tables): 'Epic' if present, else the oldest row.
    await this.execStatement(
      `MERGE INTO ${SOURCE_SYSTEMS_TABLE} t
       USING (SELECT name FROM ${SOURCE_SYSTEMS_TABLE}
              WHERE NOT EXISTS (SELECT 1 FROM ${SOURCE_SYSTEMS_TABLE} WHERE coalesce(is_default, false))
              ORDER BY CASE WHEN name = 'Epic' THEN 0 ELSE 1 END, created_at LIMIT 1) s
       ON t.name = s.name
       WHEN MATCHED THEN UPDATE SET is_default = true`,
    );
    this.sourceSystemsTableEnsured = true;
  }

  /** Load the default source system's current name into DEFAULT_SOURCE_SYSTEM (cached
   * 60s; every request calls this so a rename on any replica is picked up quickly). */
  private async refreshDefaultSourceSystem(): Promise<void> {
    const name = await this.cachedRead('sources:default', async () => {
      try {
        await this.ensureSourceSystemsTable();
        const rows = await this.runQuery(`SELECT name FROM ${SOURCE_SYSTEMS_TABLE} WHERE coalesce(is_default, false) LIMIT 1`);
        return String(rows[0]?.name ?? '');
      } catch {
        return '';
      }
    }, 60_000);
    if (name) DEFAULT_SOURCE_SYSTEM = name;
  }

  /** Source systems with descriptions, default first (Admin panel). */
  private async listSourceSystemDetails(): Promise<{ name: string; description: string | null; isDefault: boolean }[]> {
    return this.cachedRead('sources:details', async () => {
      await this.ensureSourceSystemsTable();
      const rows = await this.runQuery(
        `SELECT name, description, coalesce(is_default, false) AS is_default FROM ${SOURCE_SYSTEMS_TABLE} ORDER BY coalesce(is_default, false) DESC, name`,
      );
      return rows.map((r) => ({ name: String(r.name ?? ''), description: r.description ?? null, isDefault: String(r.is_default).toLowerCase() === 'true' }));
    });
  }

  /** List source-system names (sorted, default first). Falls back to the default on error.
   * Cached (global, admin-managed, rarely changes); invalidated on source-system writes. */
  private async listSourceSystems(): Promise<string[]> {
    return this.cachedRead('sources:list', async () => {
      try {
        await this.ensureSourceSystemsTable();
        const rows = await this.runQuery(`SELECT name FROM ${SOURCE_SYSTEMS_TABLE} ORDER BY name`);
        const names = rows.map((r) => r.name ?? '').filter(Boolean);
        return names.length ? names : [DEFAULT_SOURCE_SYSTEM];
      } catch {
        return [DEFAULT_SOURCE_SYSTEM];
      }
    });
  }

  // ---- projects (instance-level scope) -----------------------------------
  /** Ensure the projects table exists and seed one default project per source system
   * so legacy runs/examples (backfilled to `default::<sourcesystem>`) have a home.
   * Idempotent. */
  private projectsTableEnsured = false;
  private async ensureProjectsTable(): Promise<void> {
    if (this.projectsTableEnsured) return;
    await this.execStatement(
      `CREATE TABLE IF NOT EXISTS ${PROJECTS_TABLE} (
         project_id STRING NOT NULL, name STRING NOT NULL, description STRING,
         source_system STRING NOT NULL, vendor_code STRING, schema_version_id STRING,
         created_by STRING, created_at TIMESTAMP, archived BOOLEAN
       ) USING DELTA`,
    );
    // Idempotent adds for projects tables created before the vendor / schema-version fields.
    try {
      const cols = await this.runQuery(`SHOW COLUMNS IN ${PROJECTS_TABLE}`);
      const have = new Set(cols.map((c) => String(c.col_name ?? Object.values(c)[0] ?? '').toLowerCase()));
      const missing: string[] = [];
      if (!have.has('vendor_code')) missing.push('vendor_code STRING');
      if (!have.has('schema_version_id')) missing.push('schema_version_id STRING');
      if (missing.length) await this.execStatement(`ALTER TABLE ${PROJECTS_TABLE} ADD COLUMNS (${missing.join(', ')})`);
      // Backfill existing projects to the default schema version.
      await this.execStatement(`UPDATE ${PROJECTS_TABLE} SET schema_version_id = ${q(DEFAULT_SCHEMA_VERSION_ID)} WHERE schema_version_id IS NULL`);
    } catch {
      // Best-effort — a create/list will surface any real problem.
    }
    await this.ensureSourceSystemsTable();
    // Seed a "Default — <SourceSystem>" project per existing source system, with a
    // deterministic id so the backfill below can point legacy rows at it.
    await this.execStatement(
      `MERGE INTO ${PROJECTS_TABLE} t
       USING (
         SELECT concat('default::', lower(name)) AS project_id,
                concat('Default — ', name) AS name, name AS source_system
         FROM ${SOURCE_SYSTEMS_TABLE}
       ) s
       ON t.project_id = s.project_id
       WHEN NOT MATCHED THEN INSERT (project_id, name, description, source_system, vendor_code, schema_version_id, created_by, created_at, archived)
         VALUES (s.project_id, s.name, 'Auto-created for pre-existing mappings', s.source_system, NULL, ${q(DEFAULT_SCHEMA_VERSION_ID)}, 'system', CURRENT_TIMESTAMP(), false)`,
    );
    this.projectsTableEnsured = true;
  }

  // ---- vendors (the EHR vendor a project's source data comes from) --------
  /** Ensure the vendors table exists. Idempotent. No seed — vendors are curated
   * by admins in the Admin → Vendors panel. */
  private vendorsTableEnsured = false;
  private async ensureVendorsTable(): Promise<void> {
    if (this.vendorsTableEnsured) return;
    await this.execStatement(
      `CREATE TABLE IF NOT EXISTS ${VENDORS_TABLE} (
         vendor_code STRING NOT NULL, name STRING NOT NULL, description STRING,
         created_by STRING, created_at TIMESTAMP
       ) USING DELTA`,
    );
    this.vendorsTableEnsured = true;
  }

  /** Backfill NULL project_id on a scoped table to the row's source-system default
   * project (`default::<sourcesystem>`). Idempotent; best-effort. */
  private async backfillProjectIds(table: string): Promise<void> {
    try {
      await this.execStatement(
        `UPDATE ${table}
         SET project_id = concat('default::', lower(coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)})))
         WHERE project_id IS NULL`,
      );
    } catch {
      // Column may not exist yet on a very old install — the ensure*Columns pass adds
      // it first; a transient failure here just leaves rows for the next run.
    }
  }

  // ---- per-source-system mapping instructions ----------------------------
  private sourceSystemInstructionsTableEnsured = false;
  private async ensureSourceSystemInstructionsTable(): Promise<void> {
    if (this.sourceSystemInstructionsTableEnsured) return;
    await this.execStatement(
      `CREATE TABLE IF NOT EXISTS ${SOURCE_SYSTEM_INSTRUCTIONS_TABLE} (
         domain STRING NOT NULL, instructions STRING, updated_by STRING, updated_at TIMESTAMP
       ) USING DELTA`,
    );
    this.sourceSystemInstructionsTableEnsured = true;
  }

  /** The saved instruction text for a source system, or '' if none. Best-effort → ''. */
  private async loadSourceSystemInstructions(sourceSystem: string): Promise<string> {
    const ss = (sourceSystem ?? '').trim() || DEFAULT_SOURCE_SYSTEM;
    // Cached per source system — this is injected into BOTH the identify and generate
    // prompts every cycle, so it's read constantly; the text is global, admin-authored,
    // and rarely changes. Invalidated when instructions are saved (see 'instructions:').
    // (The admin editor's GET route has its own uncached query, so edits show live there.)
    return this.cachedRead(`instructions:${ss}`, async () => {
      try {
        await this.ensureSourceSystemInstructionsTable();
        const rows = await this.runQuery(
          `SELECT instructions FROM ${SOURCE_SYSTEM_INSTRUCTIONS_TABLE} WHERE domain = ${q(ss)} LIMIT 1`,
        );
        return (rows[0]?.instructions ?? '').trim();
      } catch {
        return '';
      }
    });
  }

  // ---- retrieval corpus (Vector Search source) ---------------------------
  /** Ensure the retrieval corpus table exists. Change Data Feed is required for a
   * CONTINUOUS Delta Sync index to pick up row changes. Idempotent. */
  private corpusTableEnsured = false;
  private async ensureCorpusTable(): Promise<void> {
    if (this.corpusTableEnsured) return;
    await this.execStatement(
      `CREATE TABLE IF NOT EXISTS ${CORPUS_TABLE} (
         id STRING NOT NULL,          -- 'example:<id>' or 'run:<item_id>'
         kind STRING,                 -- 'example' | 'history'
         domain STRING, project_id STRING, target_table STRING, source_signature STRING,
         content STRING,              -- text embedded by the VS index
         generated_sql STRING, updated_at TIMESTAMP
       ) USING DELTA TBLPROPERTIES (delta.enableChangeDataFeed = true)`,
    );
    // Idempotent add for corpus tables created before project scoping existed.
    try {
      const cols = await this.runQuery(`SHOW COLUMNS IN ${CORPUS_TABLE}`);
      const have = new Set(cols.map((c) => String(c.col_name ?? Object.values(c)[0] ?? '').toLowerCase()));
      if (!have.has('project_id')) {
        await this.execStatement(`ALTER TABLE ${CORPUS_TABLE} ADD COLUMNS (project_id STRING)`);
      }
    } catch {
      // Best-effort — a rebuild repopulates the column regardless.
    }
    this.corpusTableEnsured = true;
  }

  /** Compact structural fingerprint of a mapping's SQL — its shape (UNION legs, CTEs,
   * per-column CASE, window fns, nested subqueries) plus join count. Embedded in place
   * of a raw SQL slice so retrieval keys on the mapping's structure, not on the
   * boilerplate leading lines of a large SQL body (a 500-line example used to be
   * represented by just its first CTE). Heuristics are substring/count based so the TS
   * write-through here and the set-based rebuild paths (rebuildCorpus /
   * 06_retrieval_corpus.sql / retrieval_sync_notebook.py) produce the same text. */
  private static structuralTags(sql: string | null): string {
    const s = (sql ?? '').toLowerCase();
    if (!s.trim()) return '';
    const tags: string[] = [];
    if (s.includes('union')) tags.push('union');
    if (s.includes('with ')) tags.push('cte');
    if (s.includes('case when')) tags.push('case');
    if (s.includes('over(') || s.includes('over (')) tags.push('window');
    if ((s.match(/select/g)?.length ?? 0) > 1) tags.push('subquery');
    const joins = s.match(/join/g)?.length ?? 0;
    const body = tags.join(', ');
    return `Structure: ${body}${body ? '; ' : ''}joins=${joins}`;
  }

  /** SQL expression mirroring {@link structuralTags} for the set-based rebuild paths.
   * Assumes a non-null `generated_sql` column — both rebuild queries filter it NOT NULL. */
  private static structureSql(): string {
    return (
      `concat('\\nStructure: ', concat_ws('; ', ` +
      `nullif(concat_ws(', ', ` +
      `CASE WHEN contains(lower(generated_sql), 'union') THEN 'union' END, ` +
      `CASE WHEN contains(lower(generated_sql), 'with ') THEN 'cte' END, ` +
      `CASE WHEN contains(lower(generated_sql), 'case when') THEN 'case' END, ` +
      `CASE WHEN contains(lower(generated_sql), 'over(') OR contains(lower(generated_sql), 'over (') THEN 'window' END, ` +
      `CASE WHEN regexp_count(lower(generated_sql), 'select') > 1 THEN 'subquery' END), ''), ` +
      `concat('joins=', cast(regexp_count(lower(generated_sql), 'join') AS STRING))))`
    );
  }

  /** The text an index row embeds — target + source signature/columns + a compact
   * structural fingerprint of the mapping (see {@link structuralTags}), so semantic
   * retrieval keys on what the mapping is about and how it's shaped rather than on the
   * leading boilerplate of a large SQL body. */
  private static corpusContent(targetTable: string, sourceSignature: string | null, sourceColumns: string | null, sql: string | null): string {
    const parts = [
      `Target entity: ${targetTable}`,
      sourceSignature ? `Source: ${sourceSignature}` : '',
      sourceColumns ? `Source columns: ${sourceColumns}` : '',
      AiMapper.structuralTags(sql),
    ].filter(Boolean);
    return parts.join('\n');
  }

  /** Upsert one corpus row (best-effort — must never break the primary write). */
  private async upsertCorpusRow(row: {
    id: string; kind: string; domain: string; projectId: string; targetTable: string;
    sourceSignature: string | null; sourceColumns: string | null; generatedSql: string | null;
  }): Promise<void> {
    if (!VS_INDEX) return; // no index configured → skip corpus maintenance
    try {
      await this.ensureCorpusTable();
      const content = AiMapper.corpusContent(row.targetTable, row.sourceSignature, row.sourceColumns, row.generatedSql);
      // Parameterized so the generated SQL / content quotes aren't stripped by the API.
      await this.execStatement(
        `MERGE INTO ${CORPUS_TABLE} t
         USING (SELECT :id AS id, :kind AS kind, :domain AS domain, :project_id AS project_id,
                       :target_table AS target_table, :source_signature AS source_signature,
                       :content AS content, :generated_sql AS generated_sql) s
         ON t.id = s.id
         WHEN MATCHED THEN UPDATE SET kind=s.kind, domain=s.domain, project_id=s.project_id, target_table=s.target_table,
              source_signature=s.source_signature, content=s.content, generated_sql=s.generated_sql, updated_at=CURRENT_TIMESTAMP()
         WHEN NOT MATCHED THEN INSERT (id, kind, domain, project_id, target_table, source_signature, content, generated_sql, updated_at)
              VALUES (s.id, s.kind, s.domain, s.project_id, s.target_table, s.source_signature, s.content, s.generated_sql, CURRENT_TIMESTAMP())`,
        [
          { name: 'id', value: row.id },
          { name: 'kind', value: row.kind },
          { name: 'domain', value: row.domain },
          { name: 'project_id', value: row.projectId },
          { name: 'target_table', value: row.targetTable },
          { name: 'source_signature', value: row.sourceSignature ?? null },
          { name: 'content', value: content },
          { name: 'generated_sql', value: row.generatedSql ?? null },
        ],
      );
    } catch {
      // Corpus is a derived cache — a failure here must not fail the caller.
    }
  }

  /** Remove a corpus row (best-effort). */
  private async deleteCorpusRow(id: string): Promise<void> {
    if (!VS_INDEX) return;
    try {
      await this.ensureCorpusTable();
      await this.execStatement(`DELETE FROM ${CORPUS_TABLE} WHERE id = ${q(id)}`);
    } catch {
      // ignore — derived cache
    }
  }

  /** Rebuild the corpus from the base tables (approved examples + approved history).
   * Used for the initial backfill and repair. Full replace via INSERT OVERWRITE so
   * it converges regardless of prior state. Returns the row count. */
  private async rebuildCorpus(): Promise<number> {
    await this.ensureCorpusTable();
    // INSERT OVERWRITE with a UNION of both sources, shaping the same content text
    // the write-through builds (target + source signature/columns + structural fingerprint).
    await this.execStatement(
      // BY NAME so it matches columns by alias regardless of physical order — the
      // `project_id` column is appended last on migrated corpus tables.
      `INSERT OVERWRITE ${CORPUS_TABLE} BY NAME
       SELECT concat('example:', example_id) AS id, 'example' AS kind,
              coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)}) AS domain,
              coalesce(project_id, concat('default::', lower(coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)})))) AS project_id,
              target_table,
              source_signature,
              concat('Target entity: ', target_table,
                     coalesce(concat('\\nSource: ', source_signature), ''),
                     coalesce(concat('\\nSource columns: ', source_columns), ''),
                     ${AiMapper.structureSql()}) AS content,
              generated_sql, CURRENT_TIMESTAMP() AS updated_at
       FROM ${EXAMPLES_TABLE} WHERE approved = true AND generated_sql IS NOT NULL
       UNION ALL
       SELECT concat('run:', item_id) AS id, 'history' AS kind,
              coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)}) AS domain,
              coalesce(project_id, concat('default::', lower(coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)})))) AS project_id,
              target_table,
              concat_ws('.', source_catalog, source_schema, source_table) AS source_signature,
              concat('Target entity: ', target_table,
                     coalesce(concat('\\nSource: ', concat_ws('.', source_catalog, source_schema, source_table)), ''),
                     ${AiMapper.structureSql()}) AS content,
              generated_sql, CURRENT_TIMESTAMP() AS updated_at
       FROM ${HISTORY_TABLE}
       WHERE lower(coalesce(approval_status,'draft')) = 'approved' AND target_table IS NOT NULL AND generated_sql IS NOT NULL`,
    );
    // Trigger the index to re-embed the refreshed corpus (Storage-Optimized indexes
    // are TRIGGERED, not continuous, so freshness is driven by this sync). Best-effort.
    await this.syncRetrievalIndex();
    const rows = await this.runQuery(`SELECT COUNT(*) AS n FROM ${CORPUS_TABLE}`);
    return intOr(rows[0]?.n ?? null, 0);
  }

  /** Trigger a TRIGGERED Delta Sync index to re-embed the corpus. Best-effort. */
  private async syncRetrievalIndex(): Promise<void> {
    if (!VS_INDEX.trim()) return;
    try {
      await this.ctx().client.vectorSearchIndexes.syncIndex({ index_name: VS_INDEX });
    } catch {
      // Index may be mid-sync or not ready — non-fatal.
    }
  }

  // ---- roles --------------------------------------------------------------
  /** Ensure the roles table exists. One row per principal: `user_email` holds the
   * user's email OR the group's display name, `principal_type` says which (NULL on
   * legacy rows = user). Idempotent; adds principal_type to pre-existing tables. */
  private rolesTableEnsured = false;
  private async ensureRolesTable(): Promise<void> {
    if (this.rolesTableEnsured) return;
    await this.execStatement(
      `CREATE TABLE IF NOT EXISTS ${ROLES_TABLE} (
         user_email STRING NOT NULL, role STRING NOT NULL,
         updated_by STRING, updated_at TIMESTAMP,
         principal_type STRING COMMENT 'user | group (NULL = user)'
       ) USING DELTA`,
    );
    try {
      const cols = await this.runQuery(`DESCRIBE TABLE ${ROLES_TABLE}`);
      const have = new Set(cols.map((c) => String(c.col_name ?? '').toLowerCase()));
      if (!have.has('principal_type')) {
        await this.execStatement(`ALTER TABLE ${ROLES_TABLE} ADD COLUMNS (principal_type STRING COMMENT 'user | group (NULL = user)')`);
      }
    } catch {
      // Best-effort: without the column, group assignments simply can't be saved.
    }
    this.rolesTableEnsured = true;
  }

  /** Display names of the signed-in user's workspace groups (direct memberships, as
   * reported by SCIM /Me), lower-cased. Cached per user for 5 minutes. */
  private async currentUserGroups(): Promise<string[]> {
    const email = this.currentUser().toLowerCase();
    return this.cachedRead(`me-groups:${email}`, async () => {
      const me = (await this.ctx().client.currentUser.me().catch(() => null)) as
        | { groups?: { display?: string; value?: string }[] }
        | null;
      return (me?.groups ?? []).map((g) => String(g.display ?? '').toLowerCase()).filter(Boolean);
    }, 5 * 60_000);
  }

  /** True if `name` is a workspace-local group (SCIM meta.resourceType WorkspaceGroup). */
  private async isWorkspaceLocalGroup(name: string): Promise<boolean> {
    const list = await this.listWorkspacePrincipals();
    const g = list.groups.find((x) => x.displayName.toLowerCase() === name.toLowerCase());
    return !!g?.workspaceLocal;
  }

  /** Workspace users + groups for the Admin role picker, via SCIM. Tries the signed-in
   * admin's OBO token first, then the app service principal; returns empty lists with
   * an error message if neither can list (the UI then falls back to typing). */
  private async listWorkspacePrincipals(): Promise<{
    users: { userName: string; displayName: string | null }[];
    groups: { displayName: string; workspaceLocal: boolean }[];
    error: string | null;
  }> {
    const res = await this.cachedRead('principals', async () => {
      const fetchAll = async (client: WorkspaceClient, kind: 'Users' | 'Groups', attributes: string) => {
        const out: Record<string, unknown>[] = [];
        const pageSize = 100;
        for (let start = 1; start < 20_000; start += pageSize) {
          const resp = (await client.apiClient.request({
            path: `/api/2.0/preview/scim/v2/${kind}`,
            method: 'GET',
            query: { attributes, count: String(pageSize), startIndex: String(start) },
            headers: new Headers({ Accept: 'application/scim+json' }),
            raw: false,
          })) as { Resources?: Record<string, unknown>[]; totalResults?: number } | null;
          const page = resp?.Resources ?? [];
          out.push(...page);
          if (page.length < pageSize || out.length >= (resp?.totalResults ?? 0)) break;
        }
        return out;
      };
      const attempts: [string, () => WorkspaceClient][] = [
        ['user', () => this.ctx().client],
        ['service principal', () => this.serviceClient()],
      ];
      const errs: string[] = [];
      for (const [label, getClient] of attempts) {
        try {
          const client = getClient();
          const [users, groups] = await Promise.all([
            fetchAll(client, 'Users', 'userName,displayName,active'),
            fetchAll(client, 'Groups', 'displayName,meta'),
          ]);
          return {
            users: users
              .filter((u) => u.active !== false && typeof u.userName === 'string')
              .map((u) => ({ userName: String(u.userName), displayName: (u.displayName as string | undefined) ?? null }))
              .sort((a, b) => a.userName.localeCompare(b.userName)),
            groups: groups
              .filter((g) => typeof g.displayName === 'string')
              .map((g) => ({
                displayName: String(g.displayName),
                workspaceLocal: (g.meta as { resourceType?: string } | undefined)?.resourceType === 'WorkspaceGroup',
              }))
              .sort((a, b) => a.displayName.localeCompare(b.displayName)),
            error: null,
          };
        } catch (e) {
          errs.push(`${label}: ${errMsg(e)}`);
          console.warn(`[aimapper] listing workspace principals as ${label} failed: ${errMsg(e)}`);
        }
      }
      return { users: [], groups: [], error: `Could not list workspace users and groups (${errs.join('; ')}).` };
    }, 5 * 60_000);
    // Never keep a failed lookup cached — retry on the next request.
    if (res.error) this.invalidateCache('principals');
    return res;
  }

  // ---- role groups (account groups that carry each role's permissions) ----------
  // Membership is changed through the workspace's account-SCIM proxy as the app
  // SERVICE PRINCIPAL: user sign-in tokens can't carry the `scim` scope, so the admin's
  // own token can't edit groups. The SP must be a Group manager of the three groups
  // (setup/install.py); routes check the caller is an app admin first.

  /** Account SCIM call via the workspace proxy. Uses fetch (not apiClient) because the
   * SDK drops PATCH bodies. */
  private async accountScim<T>(method: 'GET' | 'PATCH', path: string, query?: Record<string, string>, body?: unknown): Promise<T | null> {
    const client = this.serviceClient();
    const headers = new Headers({ Accept: 'application/scim+json', 'Content-Type': 'application/scim+json' });
    await client.config.authenticate(headers);
    const url = new URL(`/api/2.0/account/scim/v2/${path}`, await client.config.getHost());
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const resp = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await resp.text();
    if (!resp.ok) {
      let detail = text;
      try {
        const j = JSON.parse(text) as { detail?: string; message?: string };
        detail = j.detail ?? j.message ?? text;
      } catch { /* not JSON */ }
      throw new Error(`${resp.status} ${detail}`.trim());
    }
    return text ? (JSON.parse(text) as T) : null;
  }

  /** Account id of a user (by email) or group (by display name), or null if none. */
  private async findAccountPrincipal(name: string, kind: PrincipalKind): Promise<{ id: string; display: string } | null> {
    const r = await this.accountScim<{ Resources?: { id: string; userName?: string; displayName?: string }[] }>(
      'GET',
      kind === 'group' ? 'Groups' : 'Users',
      { filter: scimEq(kind === 'group' ? 'displayName' : 'userName', name), attributes: 'id,userName,displayName' },
    );
    const hit = r?.Resources?.[0];
    return hit ? { id: String(hit.id), display: String(kind === 'group' ? hit.displayName : hit.userName ?? name) } : null;
  }

  /** The three role groups' account ids (null = group not found → run setup). */
  private async roleGroupIds(): Promise<Record<Role, string | null>> {
    const res = await this.cachedRead('rolegroups:ids', async () => {
      const out = {} as Record<Role, string | null>;
      await Promise.all(ROLE_ORDER.map(async (r) => {
        out[r] = (await this.findAccountPrincipal(ROLE_GROUPS[r], 'group'))?.id ?? null;
      }));
      return out;
    }, 10 * 60_000);
    if (ROLE_ORDER.some((r) => !res[r])) this.invalidateCache('rolegroups:ids');
    return res;
  }

  /** Members of every role group, one row per principal at its highest role. */
  private async listRoleMembers(): Promise<{
    groups: { role: Role; name: string; id: string | null; members: number }[];
    members: (RoleMembership & { principal: string; alsoIn: Role[] })[];
  }> {
    const ids = await this.roleGroupIds();
    const raw: RoleMembership[] = [];
    const counts = {} as Record<Role, number>;
    await Promise.all(ROLE_ORDER.map(async (r) => {
      counts[r] = 0;
      const id = ids[r];
      if (!id) return;
      const g = await this.accountScim<{ members?: { value: string; display?: string; $ref?: string }[] }>('GET', `Groups/${id}`);
      for (const m of g?.members ?? []) {
        raw.push({ id: String(m.value), kind: memberKind(m.$ref), display: String(m.display ?? m.value), role: r });
        counts[r]++;
      }
    }));
    // SCIM members carry display names, not emails — resolve users' userName.
    const members = await Promise.all(collapseMemberships(raw).map(async (m) => {
      if (m.kind !== 'user') return { ...m, principal: m.display };
      const u = await this.accountScim<{ userName?: string }>('GET', `Users/${m.id}`, { attributes: 'userName' }).catch(() => null);
      return { ...m, principal: String(u?.userName ?? m.display) };
    }));
    return {
      groups: ROLE_ORDER.slice().reverse().map((r) => ({ role: r, name: ROLE_GROUPS[r], id: ids[r], members: counts[r] })),
      members,
    };
  }

  /** Put `principal` in exactly `role`'s group (role=null → remove from all role
   * groups). Returns a human-readable summary of what changed. */
  private async setRoleMembership(name: string, kind: PrincipalKind, role: Role | null): Promise<string[]> {
    if (kind === 'group' && ROLE_ORDER.some((r) => ROLE_GROUPS[r].toLowerCase() === name.toLowerCase())) {
      throw new Error(`${name} is itself a role group and can't be nested into another.`);
    }
    const ids = await this.roleGroupIds();
    const missing = ROLE_ORDER.filter((r) => !ids[r]);
    if (missing.length) {
      throw new Error(`Role group(s) not found: ${missing.map((r) => ROLE_GROUPS[r]).join(', ')}. Run setup/install.py first.`);
    }
    const who = await this.findAccountPrincipal(name, kind);
    if (!who) {
      throw new Error(kind === 'group'
        ? `No account group named "${name}". Workspace-local groups can't be added to role groups — use an account group.`
        : `No Databricks account user with email ${name}.`);
    }
    const memberOf: Role[] = [];
    await Promise.all(ROLE_ORDER.map(async (r) => {
      const g = await this.accountScim<{ members?: { value: string }[] }>('GET', `Groups/${ids[r]}`, { attributes: 'members' });
      if ((g?.members ?? []).some((m) => String(m.value) === who.id)) memberOf.push(r);
    }));
    const plan = planMembershipChange(memberOf, role);
    const patch = (r: Role, op: object) =>
      this.accountScim('PATCH', `Groups/${ids[r]}`, undefined, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [op] });
    const done: string[] = [];
    const wrap = async (verb: string, r: Role, fn: () => Promise<unknown>) => {
      try {
        await fn();
        done.push(`${verb} ${ROLE_GROUPS[r]}`);
      } catch (e) {
        const msg = errMsg(e);
        const hint = /403|permission|not authorized|forbidden/i.test(msg)
          ? ' — the app service principal must be a Group manager of the role groups (setup/install.py).'
          : '';
        throw new Error(`Couldn't ${verb === 'added to' ? 'add' : 'remove'} ${name} ${verb === 'added to' ? 'to' : 'from'} ${ROLE_GROUPS[r]}: ${msg}${hint}${done.length ? ` (already ${done.join(', ')})` : ''}`);
      }
    };
    // Add first, then remove — a failed add never leaves the principal with no role.
    if (plan.add) await wrap('added to', plan.add, () => patch(plan.add!, { op: 'add', path: 'members', value: [{ value: who.id }] }));
    for (const r of plan.remove) await wrap('removed from', r, () => patch(r, { op: 'remove', path: `members[value eq "${who.id}"]` }));
    // Roles are resolved from cached /Me groups — drop them so changes apply promptly.
    this.invalidateCache('me-groups:');
    return done;
  }

  /**
   * Resolve the signed-in user's role. Bootstrap admins (env) always win so the
   * app is never lockable-out; otherwise the highest role group the user is in
   * (SCIM /Me lists direct AND indirect groups); default 'viewer'.
   */
  private async currentRole(): Promise<Role> {
    const email = this.currentUser().toLowerCase();
    if (BOOTSTRAP_ADMINS.has(email)) return 'admin';
    const groups = await this.currentUserGroups().catch(() => [] as string[]);
    return roleFromGroups(groups, ROLE_GROUPS) ?? 'viewer';
  }

  /** Throw ForbiddenError (→403) unless the caller's role meets `min`. */
  private async requireRole(min: Role): Promise<Role> {
    const role = await this.currentRole();
    if (ROLE_RANK[role] < ROLE_RANK[min]) {
      throw new ForbiddenError(
        `This action requires the '${min}' role or higher; you are '${role}'.`,
      );
    }
    return role;
  }

  // ---- statement execution ------------------------------------------------
  private async execStatement(statement: string, params?: { name: string; value: string | null; type?: string }[]) {
    const ctx = this.ctx();
    return ctx.client.statementExecution.executeStatement({
      warehouse_id: this.warehouseId(),
      statement,
      wait_timeout: '50s',
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
      // Bound parameters (`:name`) — REQUIRED for any value that can contain single
      // quotes (generated SQL, rationale, JSON). Inline-escaping via q() does NOT
      // survive the Statement Execution API: it strips the doubled quotes, which
      // silently corrupted every stored generated_sql. Parameters preserve them.
      ...(params && params.length
        ? { parameters: params.map((p) => ({ name: p.name, value: p.value ?? undefined, type: p.type ?? 'STRING' })) }
        : {}),
    });
  }

  /** Execute a SELECT and return rows as objects keyed by column name. */
  private async runQuery(statement: string): Promise<Record<string, string | null>[]> {
    const resp = await this.execStatement(statement);
    if (resp.status?.state !== 'SUCCEEDED') {
      throw new Error(resp.status?.error?.message ?? 'query failed');
    }
    const cols = (resp.manifest?.schema?.columns ?? []).map((c) => c.name ?? '');
    const data = resp.result?.data_array ?? [];
    return data.map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i] ?? null])));
  }

  // ---- LLM ----------------------------------------------------------------
  /** Query a chat serving endpoint; returns the content and the response's token
   * usage so callers can track per-task consumption. Usage is 0 if omitted. */
  private async invokeLlmWithUsage(
    endpoint: string,
    messages: { role: string; content: string }[],
    maxTokens = 2000,
  ): Promise<{ content: string; usage: TokenUsage; finishReason: string | null; completionTokens: number }> {
    const ctx = this.ctx();
    const chat = messages.map((m) => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content }));
    // Prefer temperature=0 for deterministic output, but some models (Claude Opus,
    // GPT-5 family) reject an explicit temperature — retry without it.
    let resp: unknown;
    try {
      resp = await ctx.client.servingEndpoints.query({ name: endpoint, messages: chat, max_tokens: maxTokens, temperature: 0 });
    } catch (e) {
      if (!errMsg(e).toLowerCase().includes('temperature')) throw e;
      resp = await ctx.client.servingEndpoints.query({ name: endpoint, messages: chat, max_tokens: maxTokens });
    }
    const r = resp as { choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: Record<string, unknown> };
    const content = r.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty LLM response');
    const u = r.usage ?? {};
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const promptTokens = n(u.prompt_tokens);
    const completionTokens = n(u.completion_tokens);
    const totalTokens = n(u.total_tokens) || promptTokens + completionTokens;
    // finish_reason is 'length' when the output hit max_tokens — but some Databricks
    // endpoints leave it null even on truncation, so callers also compare
    // completionTokens against the requested cap as the primary truncation signal.
    const fr = r.choices?.[0]?.finish_reason;
    const finishReason = typeof fr === 'string' ? fr : null;
    return { content, usage: { promptTokens, completionTokens, totalTokens }, finishReason, completionTokens };
  }

  // ---- admin settings: Prompt Sizing profile ------------------------------
  /** Ensure the generic admin settings table exists. Idempotent + memoized. */
  private settingsTableEnsured = false;
  private async ensureSettingsTable(): Promise<void> {
    if (this.settingsTableEnsured) return;
    await this.execStatement(
      `CREATE TABLE IF NOT EXISTS ${SETTINGS_TABLE} (
         key STRING NOT NULL, value STRING, updated_by STRING, updated_at TIMESTAMP
       ) USING DELTA`,
    );
    this.settingsTableEnsured = true;
  }

  /** The active Prompt Sizing profile: admin DB setting → env → default. Cached. */
  private async loadPromptProfile(): Promise<PromptProfile> {
    return this.cachedRead('settings:prompt_profile', async () => {
      const envProfile = (process.env.AIMAPPER_PROMPT_PROFILE ?? '').toLowerCase();
      let dbVal = '';
      try {
        await this.ensureSettingsTable();
        const rows = await this.runQuery(`SELECT value FROM ${SETTINGS_TABLE} WHERE key = 'prompt_profile' LIMIT 1`);
        dbVal = (rows[0]?.value ?? '').toLowerCase();
      } catch {
        // settings table unreadable → fall back to env/default
      }
      const pick = dbVal || envProfile || DEFAULT_PROMPT_PROFILE;
      return (pick in PROMPT_PROFILES ? pick : DEFAULT_PROMPT_PROFILE) as PromptProfile;
    });
  }

  /** Resolve the active profile to its concrete limits. */
  private async loadPromptLimits(): Promise<PromptLimits> {
    return resolvePromptProfile(await this.loadPromptProfile());
  }

  // ---- serving-endpoint access + task-size model selection ----------------
  /** Chat endpoints the CURRENT USER can actually QUERY (CAN_QUERY/CAN_MANAGE),
   * cached per user. Narrows the OBO-visible list by per-endpoint permissions so
   * the UI never offers an endpoint the user will only fail on at run time.
   * FAIL-OPEN: an endpoint whose permissions can't be read is kept. */
  private async queryableEndpoints(): Promise<{ name: string; task: string }[]> {
    const ctx = this.ctx();
    const me = (await ctx.client.currentUser.me().catch(() => null)) as
      | { userName?: string; groups?: { display?: string; value?: string }[] }
      | null;
    const userName = (me?.userName ?? '').toLowerCase();
    const groups = new Set(
      (me?.groups ?? []).map((g) => String(g.display ?? g.value ?? '').toLowerCase()).filter(Boolean),
    );
    const BROAD = new Set(['users', 'account users', 'admins']);
    return this.cachedRead(`endpoints:${userName}`, async () => {
      const responsesOnly = new Set(['databricks-gpt-5-2-codex', 'databricks-gpt-5-3-codex', 'databricks-gpt-5-5-pro']);
      const candidates: { name: string; task: string; id?: string }[] = [];
      try {
        for await (const e of ctx.client.servingEndpoints.list()) {
          const task = e.task ?? '';
          if (!e.name || !task.includes('chat')) continue;
          if (responsesOnly.has(e.name) || e.name.endsWith('-codex') || e.name.endsWith('-pro')) continue;
          if (e.state?.ready === 'NOT_READY') continue;
          candidates.push({ name: e.name, task, id: (e as { id?: string }).id });
        }
      } catch {
        return [];
      }
      const ok = await Promise.all(
        candidates.map(async (c) => {
          if (!c.id) return true; // no id → can't check → keep (fail-open)
          try {
            const perms = (await ctx.client.servingEndpoints.getPermissions({ serving_endpoint_id: c.id })) as {
              access_control_list?: { user_name?: string; group_name?: string; all_permissions?: { permission_level?: string }[] }[];
            };
            const acl = perms.access_control_list ?? [];
            return acl.some((a) => {
              const lvls = (a.all_permissions ?? []).map((p) => String(p.permission_level ?? '').toUpperCase());
              if (!lvls.includes('CAN_QUERY') && !lvls.includes('CAN_MANAGE')) return false;
              const u = String(a.user_name ?? '').toLowerCase();
              const g = String(a.group_name ?? '').toLowerCase();
              return (!!u && u === userName) || (!!g && (groups.has(g) || BROAD.has(g)));
            });
          } catch {
            return true; // permissions unreadable → keep (fail-open)
          }
        }),
      );
      return candidates.filter((_, i) => ok[i]).map((c) => ({ name: c.name, task: c.task }));
    });
  }

  /** Names of endpoints the current user can query (for selection fallback). */
  private async userQueryableEndpoints(): Promise<Set<string>> {
    return new Set((await this.queryableEndpoints()).map((e) => e.name));
  }

  /** Whether task-size model auto-selection is enabled (admin setting). Cached. */
  private async loadAutoModelSelect(): Promise<boolean> {
    return this.cachedRead('settings:auto_model_select', async () => {
      try {
        await this.ensureSettingsTable();
        const r = await this.runQuery(`SELECT value FROM ${SETTINGS_TABLE} WHERE key = 'auto_model_select' LIMIT 1`);
        const v = r[0]?.value;
        // ON by default: only an explicit saved 'off' disables it. (With tiers
        // unconfigured, selectEndpoint falls back to the default endpoint, so this
        // is behavior-preserving until an admin sets up tiers.)
        return v == null ? true : v.trim().toLowerCase() === 'on';
      } catch {
        return true;
      }
    });
  }

  /** The configured per-tier endpoints for auto-selection. Cached. */
  private async loadModelTiers(): Promise<{ strong: string; standard: string; light: string }> {
    return this.cachedRead('settings:model_tiers', async () => {
      const empty = { strong: '', standard: '', light: '' };
      try {
        await this.ensureSettingsTable();
        const r = await this.runQuery(`SELECT value FROM ${SETTINGS_TABLE} WHERE key = 'model_tiers' LIMIT 1`);
        const raw = r[0]?.value;
        if (!raw) return empty;
        const o = JSON.parse(raw) as Partial<typeof empty>;
        return { strong: String(o.strong ?? ''), standard: String(o.standard ?? ''), light: String(o.light ?? '') };
      } catch {
        return empty;
      }
    });
  }

  /** Pick the serving endpoint for a run. An explicit (non-'auto') request always
   * wins. When auto-selection is on and the request is 'auto'/'', route by task size
   * to the matching tier, falling through tiers and only ever returning an endpoint
   * the current user can query. */
  private async selectEndpoint(
    requested: string,
    signals: { targetCols: number; sourceCols: number; sourceTables: number; maxExampleChars: number },
  ): Promise<string> {
    const req = (requested ?? '').trim();
    const auto = await this.loadAutoModelSelect();
    if (!auto || (req && req.toLowerCase() !== 'auto')) return req; // user override wins
    const tiers = await this.loadModelTiers();
    const { targetCols, sourceTables, maxExampleChars } = signals;
    const tier: 'strong' | 'standard' | 'light' =
      targetCols >= 25 || maxExampleChars > 15000 || sourceTables >= 4
        ? 'strong'
        : targetCols <= 8 && maxExampleChars === 0 && sourceTables <= 1
          ? 'light'
          : 'standard';
    const order: ('strong' | 'standard' | 'light')[] =
      tier === 'strong' ? ['strong', 'standard', 'light'] : tier === 'light' ? ['light', 'standard', 'strong'] : ['standard', 'strong', 'light'];
    const allowed = await this.userQueryableEndpoints();
    for (const t of order) {
      const name = tiers[t];
      if (name && allowed.has(name)) return name;
    }
    if (req && req.toLowerCase() !== 'auto' && allowed.has(req)) return req;
    // No tier matched (e.g. auto on by default but tiers unconfigured) → fall back to
    // the app's default serving endpoint so an auto run behaves like a normal run,
    // not an arbitrary pick.
    const def = (process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? '').trim();
    if (def && allowed.has(def)) return def;
    return [...allowed][0] ?? req; // last resort: any queryable endpoint, else the raw request
  }

  // ---- config: which table holds the target metadata -----------------
  /** Ensure the single-row config table exists (id='target_schema'). Idempotent + memoized
   * per process so the DDL runs once, not on every config read. */
  private configTableEnsured = false;
  private async ensureConfigTable(): Promise<void> {
    if (this.configTableEnsured) return;
    await this.execStatement(
      `CREATE TABLE IF NOT EXISTS ${CONFIG_TABLE} (
         id STRING NOT NULL, target_schema_table STRING, updated_at TIMESTAMP, updated_by STRING
       ) USING DELTA`,
    );
    this.configTableEnsured = true;
  }

  // ---- feedback: per-mapping 👍/👎 that steers future discovery ------------
  private feedbackTableEnsured = false;
  private stepLogTableEnsured = false;
  private async ensureFeedbackTable(): Promise<void> {
    if (this.feedbackTableEnsured) return; // memoized: the DDL below runs once per process, not per request
    await this.execStatement(
      `CREATE TABLE IF NOT EXISTS ${FEEDBACK_TABLE} (
         target_table STRING NOT NULL, target_column STRING NOT NULL,
         source_table STRING, source_column STRING,
         vote STRING NOT NULL, /* up | down */
         project_id STRING,
         created_at TIMESTAMP, created_by STRING
       ) USING DELTA`,
    );
    // Idempotent add for feedback tables created before project scoping. Legacy votes
    // keep project_id = NULL and stay globally applicable (see loadFeedback).
    try {
      const cols = await this.runQuery(`SHOW COLUMNS IN ${FEEDBACK_TABLE}`);
      const have = new Set(cols.map((c) => String(c.col_name ?? Object.values(c)[0] ?? '').toLowerCase()));
      if (!have.has('project_id')) {
        await this.execStatement(`ALTER TABLE ${FEEDBACK_TABLE} ADD COLUMNS (project_id STRING)`);
      }
    } catch {
      // Best-effort — an insert/select will surface any real problem.
    }
    this.feedbackTableEnsured = true;
  }

  /** Aggregated confirmed/rejected source picks per target column, for prompt steering.
   * Scoped to `projectId` when given (legacy NULL-project votes stay globally applicable). */
  private async loadFeedback(targetTable: string, projectId?: string): Promise<
    { target_column: string; source_table: string | null; source_column: string | null; up: number; down: number }[]
  > {
    try {
      const projectClause = projectId ? ` AND (project_id = ${q(projectId)} OR project_id IS NULL)` : '';
      const rows = await this.runQuery(
        `SELECT target_column, source_table, source_column,
                SUM(CASE WHEN vote = 'up' THEN 1 ELSE 0 END) AS up,
                SUM(CASE WHEN vote = 'down' THEN 1 ELSE 0 END) AS down
         FROM ${FEEDBACK_TABLE} WHERE target_table = ${q(targetTable)}${projectClause}
         GROUP BY target_column, source_table, source_column`,
      );
      return rows.map((r) => ({
        target_column: r.target_column ?? '',
        source_table: r.source_table,
        source_column: r.source_column,
        up: intOr(r.up ?? null, 0),
        down: intOr(r.down ?? null, 0),
      }));
    } catch {
      return []; // table may not exist yet
    }
  }

  // ---- step log: per-step telemetry for mapping analysis -------------------
  // Each step (discovery, retrieval, generation, validation) is logged to a table
  // with structured details JSON. Fire-and-forget: logging never blocks or breaks
  // the main flow. A `trace_id` (returned in responses) groups related steps from
  // one user interaction so Genie can answer "why" questions about a specific run.
  private async ensureStepLogTable(): Promise<void> {
    if (this.stepLogTableEnsured) return;
    await this.execStatement(
      `CREATE TABLE IF NOT EXISTS ${STEP_LOG_TABLE} (
         step_id STRING NOT NULL COMMENT 'UUID per logged step',
         trace_id STRING COMMENT 'Groups related steps (discovery→retrieval→generation→validation)',
         run_id STRING COMMENT 'Linked to aimapper_conversion_runs.run_id after save',
         item_id STRING COMMENT 'Linked to aimapper_conversion_runs.item_id after save',
         target_table STRING NOT NULL COMMENT 'target entity',
         step STRING NOT NULL COMMENT 'discovery | retrieval | generation | validation',
         domain STRING COMMENT 'Source system (Epic, Cerner, …)',
         project_id STRING COMMENT 'Project scope',
         created_at TIMESTAMP NOT NULL COMMENT 'When the step started',
         created_by STRING COMMENT 'OBO user email',
         duration_ms BIGINT COMMENT 'Wall-clock time for this step',
         endpoint_name STRING COMMENT 'LLM serving endpoint used',
         prompt_tokens BIGINT,
         completion_tokens BIGINT,
         total_tokens BIGINT,
         details STRING COMMENT 'JSON: step-specific structured data'
       ) USING DELTA`,
    );
    this.stepLogTableEnsured = true;
  }

  /**
   * Log one step to the step-log table. Fire-and-forget: the INSERT is not awaited
   * by the caller, errors are swallowed, and the main request is never delayed.
   */
  private logStep(opts: {
    stepId?: string;
    traceId?: string;
    targetTable: string;
    step: 'discovery' | 'retrieval' | 'generation' | 'validation';
    domain?: string;
    projectId?: string;
    durationMs?: number;
    endpointName?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    details?: Record<string, unknown>;
  }): void {
    if (!CATALOG) return; // no catalog configured — skip logging
    const id = opts.stepId ?? crypto.randomUUID();
    const user = (() => { try { return this.currentUser(); } catch { return null; } })();
    const detailsJson = opts.details ? JSON.stringify(opts.details) : null;
    // Fire-and-forget: don't await, don't throw.
    void (async () => {
      try {
        await this.ensureStepLogTable();
        await this.execStatement(
          `INSERT INTO ${STEP_LOG_TABLE}
             (step_id, trace_id, target_table, step, domain, project_id, created_at, created_by,
              duration_ms, endpoint_name, prompt_tokens, completion_tokens, total_tokens, details)
           VALUES (${q(id)}, ${q(opts.traceId ?? null)}, ${q(opts.targetTable)}, ${q(opts.step)},
                   ${q(opts.domain ?? null)}, ${q(opts.projectId ?? null)}, CURRENT_TIMESTAMP(),
                   ${q(user)}, ${num(opts.durationMs)}, ${q(opts.endpointName ?? null)},
                   ${num(opts.promptTokens)}, ${num(opts.completionTokens)}, ${num(opts.totalTokens)},
                   ${q(detailsJson)})`,
        );
      } catch {
        // Step logging must never break the app.
      }
    })();
  }

  // Columns added after the original schema; kept idempotent so existing customer
  // history tables gain reload/versioning support without a manual migration.
  // Spark SQL has no `ADD COLUMNS IF NOT EXISTS`, so we detect first and add only
  // the missing columns.
  private historyColumnsEnsured = false;
  private async ensureHistoryColumns(): Promise<void> {
    if (this.historyColumnsEnsured) return;
    try {
      const cols = await this.runQuery(`SHOW COLUMNS IN ${HISTORY_TABLE}`);
      const have = new Set(cols.map((c) => String(c.col_name ?? Object.values(c)[0] ?? '').toLowerCase()));
      const missing: string[] = [];
      if (!have.has('mappings_json')) missing.push('mappings_json STRING');
      if (!have.has('version')) missing.push('version INT');
      // Approval workflow (feature 5): review lifecycle independent of validation status.
      if (!have.has('approval_status')) missing.push('approval_status STRING');
      if (!have.has('reviewed_by')) missing.push('reviewed_by STRING');
      if (!have.has('reviewed_at')) missing.push('reviewed_at TIMESTAMP');
      if (!have.has('review_note')) missing.push('review_note STRING');
      // Source system (EHR type) the run belongs to; legacy rows read as DEFAULT_SOURCE_SYSTEM.
      if (!have.has('domain')) missing.push('domain STRING');
      // Project (instance-level scope) the run belongs to; legacy rows backfilled to
      // their source system's default project below.
      if (!have.has('project_id')) missing.push('project_id STRING');
      // LLM token usage per task (identify + generate summed).
      if (!have.has('prompt_tokens')) missing.push('prompt_tokens BIGINT');
      if (!have.has('completion_tokens')) missing.push('completion_tokens BIGINT');
      if (!have.has('total_tokens')) missing.push('total_tokens BIGINT');
      if (missing.length) {
        await this.execStatement(`ALTER TABLE ${HISTORY_TABLE} ADD COLUMNS (${missing.join(', ')})`);
      }
      await this.backfillProjectIds(HISTORY_TABLE);
      this.historyColumnsEnsured = true;
    } catch {
      // Best-effort: if detection/alter fails, leave the flag unset so we retry,
      // and let the caller's INSERT surface any real problem.
    }
  }

  // Idempotent migration for the examples table — adds the `domain` (source system)
  // and `project_id` columns to existing installs (same detect-then-add pattern as
  // ensureHistoryColumns).
  private examplesColumnsEnsured = false;
  private async ensureExamplesColumns(): Promise<void> {
    if (this.examplesColumnsEnsured) return;
    try {
      const cols = await this.runQuery(`SHOW COLUMNS IN ${EXAMPLES_TABLE}`);
      const have = new Set(cols.map((c) => String(c.col_name ?? Object.values(c)[0] ?? '').toLowerCase()));
      const missing: string[] = [];
      if (!have.has('domain')) missing.push('domain STRING');
      if (!have.has('project_id')) missing.push('project_id STRING');
      if (missing.length) {
        await this.execStatement(`ALTER TABLE ${EXAMPLES_TABLE} ADD COLUMNS (${missing.join(', ')})`);
      }
      await this.backfillProjectIds(EXAMPLES_TABLE);
      this.examplesColumnsEnsured = true;
    } catch {
      // Best-effort — the caller's query will surface any real problem.
    }
  }

  /** The fully-qualified target-schema table from the legacy single-row config, or the env
   * default. Used to seed the first ("Default") schema version. */
  private async targetSchemaTable(): Promise<string> {
    this.assertCatalog();
    try {
      const rows = await this.runQuery(`SELECT target_schema_table FROM ${CONFIG_TABLE} WHERE id = 'target_schema' LIMIT 1`);
      const t = rows[0]?.target_schema_table;
      if (t && t.trim()) return t.trim();
    } catch {
      // config table may not exist yet — fall back to the default.
    }
    return DEFAULT_TARGET_SCHEMA_TABLE;
  }

  // ---- target-schema versions ----------------------------------------------
  /** Ensure the schema-versions table exists and holds at least a default version
   * (seeded from the legacy config / env default). Idempotent. */
  private schemaVersionsTableEnsured = false;
  private async ensureSchemaVersionsTable(): Promise<void> {
    if (this.schemaVersionsTableEnsured) return;
    await this.execStatement(
      `CREATE TABLE IF NOT EXISTS ${SCHEMA_VERSIONS_TABLE} (
         version_id STRING NOT NULL, label STRING NOT NULL, target_schema_table STRING NOT NULL,
         description STRING, is_default BOOLEAN,
         created_by STRING, created_at TIMESTAMP, updated_at TIMESTAMP
       ) USING DELTA`,
    );
    // Seed a default version from the existing configuration if the table is empty;
    // otherwise heal any duplicate version_ids left by an earlier cold-start seed race
    // (Delta has no unique constraint, so two concurrent first-load inserts could both
    // land — which would make an UPDATE/DELETE by version_id hit more than one row).
    try {
      const rows = await this.runQuery(`SELECT COUNT(*) AS n, COUNT(DISTINCT version_id) AS d FROM ${SCHEMA_VERSIONS_TABLE}`);
      const n = intOr(rows[0]?.n ?? null, 0);
      const distinct = intOr(rows[0]?.d ?? null, 0);
      if (n === 0) {
        const table = await this.targetSchemaTable();
        await this.execStatement(
          `INSERT INTO ${SCHEMA_VERSIONS_TABLE} (version_id, label, target_schema_table, description, is_default, created_by, created_at, updated_at)
           VALUES (${q(DEFAULT_SCHEMA_VERSION_ID)}, 'Default', ${q(table)}, 'Initial schema version (migrated from the existing configuration).', true, 'system', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
        );
      } else if (n > distinct) {
        // De-duplicate: keep the most-recently-updated row per version_id.
        await this.execStatement(
          `INSERT OVERWRITE ${SCHEMA_VERSIONS_TABLE}
           SELECT version_id, label, target_schema_table, description, is_default, created_by, created_at, updated_at FROM (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY version_id ORDER BY coalesce(updated_at, created_at) DESC) AS rn
             FROM ${SCHEMA_VERSIONS_TABLE}
           ) WHERE rn = 1`,
        );
      }
    } catch {
      // Best-effort seed/heal — a create/list will surface any real problem.
    }
    this.schemaVersionsTableEnsured = true;
  }

  /** Resolve the fully-qualified target-schema table for a version id — or the default
   * version, or the legacy config as a last resort. */
  private async resolveTargetSchemaTable(versionId?: string): Promise<string> {
    this.assertCatalog();
    try {
      await this.ensureSchemaVersionsTable();
      const vid = (versionId ?? '').trim();
      if (vid) {
        const rows = await this.runQuery(`SELECT target_schema_table FROM ${SCHEMA_VERSIONS_TABLE} WHERE version_id = ${q(vid)} LIMIT 1`);
        const t = rows[0]?.target_schema_table;
        if (t && t.trim()) return t.trim();
      }
      const def = await this.runQuery(
        `SELECT target_schema_table FROM ${SCHEMA_VERSIONS_TABLE} WHERE coalesce(is_default, false) = true ORDER BY created_at LIMIT 1`,
      );
      const dt = def[0]?.target_schema_table;
      if (dt && dt.trim()) return dt.trim();
    } catch {
      // fall through to legacy resolver
    }
    return this.targetSchemaTable();
  }

  /** Validate that `fqTable` (catalog.schema.table) looks like a target-schema
   * table: it must exist, be readable, and expose the required columns. Returns
   * {ok, message, targetCount?} — never throws for a "bad table" (only for infra). */
  private async validateTargetSchemaTable(fqTable: string): Promise<{ ok: boolean; message: string; targetCount?: number }> {
    const parts = fqTable.split('.');
    if (parts.length !== 3 || parts.some((p) => !p.trim())) {
      return { ok: false, message: 'Expected a fully-qualified catalog.schema.table name.' };
    }
    // Read the table's columns via UC (OBO); missing/forbidden tables surface here.
    let cols: string[];
    try {
      const ctx = this.ctx();
      const info = await ctx.client.tables.get({ full_name: fqTable });
      cols = (info.columns ?? []).map((c) => c.name ?? '').filter(Boolean);
    } catch (e) {
      return { ok: false, message: `Cannot read ${fqTable}: ${errMsg(e)}` };
    }
    const { columns, missing } = resolveTargetSchemaColumns(cols);
    if (missing.length) {
      return {
        ok: false,
        message: `Not a target-schema table — no column for: ${missing.map(describeTargetSchemaField).join('; ')}. Other columns are optional.`,
      };
    }
    // Confirm it actually has target rows we can read (using whichever column holds the table name).
    const tableCol = '`' + columns.target_table!.replace(/`/g, '``') + '`';
    try {
      const rows = await this.runQuery(`SELECT COUNT(DISTINCT ${tableCol}) AS n FROM ${fqTable}`);
      const n = intOr(rows[0]?.n ?? null, 0);
      if (n === 0) return { ok: false, message: 'Table has the right columns but contains no target entities.' };
      return { ok: true, message: `Valid target-schema table with ${n} target entit${n === 1 ? 'y' : 'ies'}.`, targetCount: n };
    } catch (e) {
      return { ok: false, message: `Table found but not queryable: ${errMsg(e)}` };
    }
  }

  // ---- data loaders -------------------------------------------------------
  private async loadTargetEntities(versionId?: string): Promise<TargetEntity[]> {
    this.assertCatalog();
    // Cache the target contract per version — it's global, read-mostly, and one of the
    // hottest reads. Invalidated on config-save + any schema-version write (see 'target-schema:').
    return this.cachedRead(`target-schema:${versionId ?? 'default'}`, () => this.loadTargetEntitiesUncached(versionId));
  }

  private async loadTargetEntitiesUncached(versionId?: string): Promise<TargetEntity[]> {
    const targetSchemaTable = await this.resolveTargetSchemaTable(versionId);
    // SELECT *: only the table name, column name and data type are required (under any
    // accepted column name); other contract fields are used when the table has them.
    const rows = await this.runQuery(`SELECT * FROM ${targetSchemaTable}`);
    return rowsToTargetEntities(rows);
  }

  private async sourceSchema(catalog: string, schema: string, table: string): Promise<SourceTable> {
    const ctx = this.ctx();
    const info = await ctx.client.tables.get({ full_name: `${catalog}.${schema}.${table}` });
    const columns: SourceColumn[] = (info.columns ?? []).map((c) => ({
      name: c.name ?? '',
      typeName: String(c.type_name ?? c.type_text ?? 'STRING'),
      typeText: c.type_text,
      nullable: c.nullable ?? true,
      position: c.position ?? 0,
      comment: c.comment,
    }));
    return { catalog, schema, table, columns };
  }

  private async sourceSchemas(catalog: string, schema: string, tables: string[]): Promise<SourceTable[]> {
    // Fetch table metadata in parallel with a concurrency cap (a 300-table schema
    // used to mean 300 sequential UC calls). Input order is preserved.
    const results = await mapWithConcurrency(tables, SOURCE_SCHEMA_CONCURRENCY, async (t) => {
      try {
        return await this.sourceSchema(catalog, schema, t);
      } catch {
        return null; // permissions / dropped table — skip rather than abort the batch.
      }
    });
    return results.filter((s): s is SourceTable => s !== null);
  }

  /** The SQL condition (no leading AND) that scopes a retrieval to the current
   * project, or — when Cross-Project Learning is on — to all projects of the same
   * source system. Works against any table exposing `domain` + `project_id`
   * (mapping_examples, the retrieval corpus). Legacy NULL project_id rows fold into
   * their own source system's default project. */
  private scopeClause(scope: RetrievalScope): string {
    if (scope.crossProject) {
      return `coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)}) = ${q(scope.sourceSystem || DEFAULT_SOURCE_SYSTEM)}`;
    }
    const effectiveProject = `coalesce(project_id, concat('default::', lower(coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)}))))`;
    return `${effectiveProject} = ${q(scope.projectId)}`;
  }

  /** Lexical fallback: approved examples for the target (scoped per {@link scopeClause}),
   * ranked by source-column token overlap. Returns up to `limit` candidates ordered
   * best-first; the caller applies the final relevance/budget packing. */
  private async loadExamplesFor(targetTable: string, sourceColumns: string[], limit = MAX_FEWSHOT_ITEMS, scope?: RetrievalScope): Promise<MappingExample[]> {
    const scopeClause = scope ? ` AND ${this.scopeClause(scope)}` : '';
    const rows = await this.runQuery(
      `SELECT example_id, target_table, source_signature, source_columns, generated_sql, notes, approved, created_by, created_at
       FROM ${EXAMPLES_TABLE}
       WHERE target_table = ${q(targetTable)} AND approved = true${scopeClause}
       ORDER BY created_at DESC LIMIT 200`,
    );
    if (rows.length === 0) return [];
    const srcTokens = new Set(sourceColumns.flatMap((c) => tokenize(c)));
    const scored = rows.map((r) => {
      let overlap = 0;
      for (const tok of tokenize(r.source_columns ?? '')) if (srcTokens.has(tok)) overlap++;
      return { overlap, ex: rowToExample(r) };
    });
    // Keep only items with SOME overlap when we have a source signal; otherwise
    // fall back to most-recent. Then hand back best-first up to `limit`.
    scored.sort((a, b) => b.overlap - a.overlap);
    const anyOverlap = scored.some((s) => s.overlap > 0);
    const kept = anyOverlap ? scored.filter((s) => s.overlap > 0) : scored;
    return kept.slice(0, limit).map((s) => s.ex);
  }

  /**
   * Semantic retrieval via Vector Search: ranks the WHOLE corpus (approved examples
   * + approved history) by embedding similarity, hard-filtered by {@link scopeClause}
   * + target. Returns ALL candidates scoring ≥ RELEVANCE_THRESHOLD (best-first), up to
   * the fetch ceiling — the caller trims to the item cap + char budget. Returns [] if
   * VS isn't configured or the query fails, so the caller can fall back to lexical.
   */
  private async loadExamplesViaVectorSearch(targetTable: string, sourceColumns: string[], scope?: RetrievalScope): Promise<MappingExample[]> {
    if (!VS_INDEX.trim()) return [];
    // `vector_search()` SQL TVF via the existing warehouse — runs under the `sql`
    // scope we already hold (no extra Vector Search OBO scope). The TVF has no filter
    // arg, so over-fetch and filter scope+target + threshold on the score in an outer
    // query. `search_score` is the TVF's similarity column. Query text mirrors the
    // corpus `content` shape so query and documents share one embedding space.
    const queryText = `Target entity: ${targetTable}\nSource columns: ${sourceColumns.join(', ')}`;
    const scopeClause = scope ? ` AND ${this.scopeClause(scope)}` : '';
    const sql =
      `SELECT id, target_table, domain, project_id, source_signature, generated_sql, search_score FROM (
         SELECT * FROM vector_search(index => ${q(VS_INDEX)}, query_text => ${q(queryText)}, num_results => ${VS_CANDIDATE_FETCH})
       ) WHERE target_table = ${q(targetTable)}${scopeClause} AND search_score >= ${RELEVANCE_THRESHOLD}
       ORDER BY search_score DESC`;
    const rows = await this.runQuery(sql);
    if (rows.length === 0) return [];
    return rows.map((r) => ({
      example_id: r.id ?? '',
      target_table: r.target_table ?? targetTable,
      source_signature: r.source_signature,
      source_columns: null,
      generated_sql: r.generated_sql ?? '',
      notes: null,
      approved: true,
      created_by: null,
      created_at: '',
    }));
  }

  /**
   * Preferred few-shot retrieval. Gathers ALL relevant approved examples/history
   * (semantic when VS is configured, else lexical), hard-filtered by {@link scopeClause}
   * + target, then packs them best-first within a bounded budget so the prompt stays
   * within the model context / the Apps timeout regardless of how large the corpus grows.
   */
  private async retrieveExamples(
    targetTable: string,
    sourceColumns: string[],
    scope?: RetrievalScope,
    maxItems: number = MAX_FEWSHOT_ITEMS,
    charBudget: number = FEWSHOT_CHAR_BUDGET,
  ): Promise<{ examples: MappingExample[]; method: 'vector_search' | 'lexical' }> {
    let candidates: MappingExample[] = [];
    let method: 'vector_search' | 'lexical' = 'lexical';
    if (VS_INDEX.trim()) {
      try {
        candidates = await this.loadExamplesViaVectorSearch(targetTable, sourceColumns, scope);
        if (candidates.length > 0) method = 'vector_search';
      } catch {
        // Index not ready / transient error → fall through to lexical retrieval.
      }
    }
    if (candidates.length === 0) {
      candidates = await this.loadExamplesFor(targetTable, sourceColumns, maxItems, scope);
      method = 'lexical';
    }
    // Pack best-first up to the item cap AND the char budget — include everything
    // relevant that fits, not a fixed count.
    const packed: MappingExample[] = [];
    let used = 0;
    for (const ex of candidates) {
      if (packed.length >= maxItems) break;
      const cost = (ex.generated_sql ?? '').length;
      if (packed.length > 0 && used + cost > charBudget) break; // always allow the first
      packed.push(ex);
      used += cost;
    }
    return { examples: packed, method };
  }

  // ---- Reference documents: Vector Search chunks ---------------------------
  /** Execute a statement that may outlive the 50s synchronous wait (e.g. parsing a
   * long PDF): poll until it finishes. Throws on failure or after `timeoutMs`. */
  private async runLongStatement(statement: string, timeoutMs = 15 * 60_000): Promise<void> {
    const client = this.ctx().client;
    let resp = await this.execStatement(statement);
    const started = Date.now();
    while (resp.status?.state === 'PENDING' || resp.status?.state === 'RUNNING') {
      if (Date.now() - started > timeoutMs) throw new Error('Statement timed out');
      await new Promise((r) => setTimeout(r, 3000));
      resp = await client.statementExecution.getStatement({ statement_id: resp.statement_id ?? '' });
    }
    if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? `Statement ${resp.status?.state ?? 'failed'}`);
  }

  /** Background re-index state (one run at a time per replica). */
  private refIndex: { running: boolean; startedAt: string | null; finishedAt: string | null; lastError: string | null; filesParsed: number; filesRemoved: number } =
    { running: false, startedAt: null, finishedAt: null, lastError: null, filesParsed: 0, filesRemoved: 0 };

  /** Recursively list reference files in the docs volume (path, size, modified ms). */
  private async listReferenceFiles(): Promise<{ path: string; size: number | null; modified: number | null }[]> {
    const client = this.ctx().client;
    const out: { path: string; size: number | null; modified: number | null }[] = [];
    const walk = async (dir: string, depth: number) => {
      for await (const e of client.files.listDirectoryContents({ directory_path: dir })) {
        const p = e.path ?? '';
        if (e.is_directory) { if (depth < 3) await walk(p, depth + 1); continue; }
        const name = p.split('/').pop() ?? '';
        if (!p || name.startsWith('.') || name.startsWith('_')) continue;
        out.push({ path: p, size: e.file_size ?? null, modified: e.last_modified ?? null });
      }
    };
    await walk(DOCS_VOLUME, 0);
    return out;
  }

  /** Re-index reference documents into the chunks table, then sync the index.
   * `only` = specific file paths (upload/delete); otherwise reconcile the whole
   * volume: parse new/changed files, drop chunks of files that no longer exist. */
  private async reindexReferenceDocs(only?: string[]): Promise<void> {
    if (!DOCS_INDEX.trim()) return;
    if (this.refIndex.running) return;
    this.refIndex = { running: true, startedAt: new Date().toISOString(), finishedAt: null, lastError: null, filesParsed: 0, filesRemoved: 0 };
    try {
      const listed = await this.listReferenceFiles();
      const present = new Map(listed.map((f) => [f.path, f]));
      const indexed = await this.runQuery(
        `SELECT file_path, max(file_size) AS file_size, max(unix_millis(file_modified)) AS modified_ms FROM ${REFERENCE_CHUNKS_TABLE} GROUP BY file_path`,
      );
      const indexedBy = new Map(indexed.map((r) => [String(r.file_path), r]));
      const candidates = only ?? [...new Set([...present.keys(), ...indexedBy.keys()])];
      const failures: string[] = [];
      for (const path of candidates) {
        const file = present.get(path);
        const row = indexedBy.get(path);
        if (!file) {
          if (row) {
            await this.runLongStatement(`DELETE FROM ${REFERENCE_CHUNKS_TABLE} WHERE file_path = ${q(path)}`);
            this.refIndex.filesRemoved++;
          }
          continue;
        }
        const unchanged =
          !!row && Number(row.file_size ?? -1) === (file.size ?? -2) &&
          Math.floor(Number(row.modified_ms ?? 0) / 1000) === Math.floor((file.modified ?? 0) / 1000);
        if (unchanged && !only) continue;
        try {
          await this.runLongStatement(`DELETE FROM ${REFERENCE_CHUNKS_TABLE} WHERE file_path = ${q(path)}`);
          await this.runLongStatement(`INSERT INTO ${REFERENCE_CHUNKS_TABLE} ${buildReferenceChunkSql(path, false)}`);
          this.refIndex.filesParsed++;
        } catch (e) {
          // One unparseable file (e.g. a .txt — ai_parse_document reads PDF/Office/images)
          // must not stop the rest; report it and continue.
          const name = path.split('/').pop() ?? path;
          failures.push(`${name}: ${errMsg(e).slice(0, 200)}`);
        }
      }
      if (failures.length) this.refIndex.lastError = `Could not index ${failures.length} file(s) — ${failures.join(' | ')}`;
      try {
        await this.ctx().client.vectorSearchIndexes.syncIndex({ index_name: DOCS_INDEX });
      } catch (e) {
        // Mid-sync or not ready: the hourly sync job picks the changes up.
        console.warn(`[aimapper] reference index sync deferred: ${errMsg(e)}`);
      }
      this.invalidateCache('refdocs:');
    } catch (e) {
      this.refIndex.lastError = errMsg(e);
      console.warn(`[aimapper] reference re-index failed: ${errMsg(e)}`);
    } finally {
      this.refIndex.running = false;
      this.refIndex.finishedAt = new Date().toISOString();
    }
  }

  /** Move a source system's reference documents to its renamed folder and re-point
   * their indexed passages (no re-parse). Returns warnings; never throws. */
  private async moveReferenceDocs(oldName: string, newName: string): Promise<string[]> {
    const warnings: string[] = [];
    const from = this.docsDir(oldName);
    const to = this.docsDir(newName);
    if (from === to) return warnings;
    let files: { path: string }[] = [];
    try {
      files = (await this.listReferenceFiles()).filter((f) => f.path.startsWith(`${from}/`));
    } catch (e) {
      return [`reference documents: couldn't list ${from} (${errMsg(e).slice(0, 160)})`];
    }
    const api = this.ctx().client.apiClient;
    const host = (await api.host).toString().replace(/\/$/, '');
    const authed = async (extra: Record<string, string> = {}) => {
      const h = new Headers(extra);
      await api.config.authenticate(h);
      return h;
    };
    const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
    for (const f of files) {
      const dest = `${to}${f.path.slice(from.length)}`;
      try {
        const got = await fetch(`${host}/api/2.0/fs/files${enc(f.path)}`, { headers: await authed() });
        if (!got.ok) throw new Error(`download ${got.status}`);
        const bytes = Buffer.from(await got.arrayBuffer());
        const put = await fetch(`${host}/api/2.0/fs/files${enc(dest)}?overwrite=true`, {
          method: 'PUT', headers: await authed({ 'Content-Type': 'application/octet-stream' }), body: bytes,
        });
        if (!put.ok) throw new Error(`upload ${put.status}`);
        const meta = await fetch(`${host}/api/2.0/fs/files${enc(dest)}`, { method: 'HEAD', headers: await authed() });
        const modified = Date.parse(meta.headers.get('last-modified') ?? '');
        await this.runLongStatement(
          `UPDATE ${REFERENCE_CHUNKS_TABLE} SET file_path = ${q(dest)}, source_system = ${q(newName)}` +
            (Number.isFinite(modified) ? `, file_modified = timestamp_millis(${modified})` : '') +
            ` WHERE file_path = ${q(f.path)}`,
        ).catch(() => undefined); // table may not exist when grounding is off
        await this.ctx().client.files.delete({ file_path: f.path });
      } catch (e) {
        warnings.push(`reference document ${f.path.split('/').pop()}: ${errMsg(e).slice(0, 160)} — re-upload it under ${newName}`);
      }
    }
    if (!warnings.length) {
      await fetch(`${host}/api/2.0/fs/directories${enc(from)}`, { method: 'DELETE', headers: await authed() }).catch(() => undefined);
    }
    if (files.length && DOCS_INDEX.trim()) {
      try { await this.ctx().client.vectorSearchIndexes.syncIndex({ index_name: DOCS_INDEX }); } catch { /* hourly job catches up */ }
    }
    return warnings;
  }

  /** Start a re-index without blocking the request (the Apps proxy times out ~120s). */
  private startReindex(only?: string[]): void {
    void this.reindexReferenceDocs(only);
  }

  /** Chunk counts per indexed file + totals (for the References status card). */
  private async referenceIndexStats(): Promise<{ chunks: number; files: number; lastIndexedAt: string | null; perFile: Record<string, number> }> {
    return this.cachedRead('refdocs:stats', async () => {
      const rows = await this.runQuery(
        `SELECT file_path, count(*) AS n, max(indexed_at) AS last FROM ${REFERENCE_CHUNKS_TABLE} GROUP BY file_path`,
      ).catch(() => [] as Record<string, string | null>[]);
      const perFile: Record<string, number> = {};
      let chunks = 0;
      let last: string | null = null;
      for (const r of rows) {
        const n = intOr(r.n ?? null, 0);
        perFile[String(r.file_path)] = n;
        chunks += n;
        if (r.last && (!last || String(r.last) > last)) last = String(r.last);
      }
      return { chunks, files: rows.length, lastIndexedAt: last, perFile };
    }, 30_000);
  }

  /** Retrieve + pack reference chunks for a mapping (see references.ts). */
  private async loadReferenceChunks(
    targetTable: string,
    targetColumns: string[],
    sourceColumns: string[],
    sourceSystem: string | undefined,
    budgetChars: number,
  ): Promise<{ text: string; sources: ReferenceSource[] }> {
    const queries = buildReferenceQueries(targetTable, targetColumns, sourceColumns);
    const ss = (sourceSystem ?? '').trim();
    const results = await Promise.all(
      queries.map(async (qt) => {
        const rows = await this.runQuery(
          `SELECT chunk_id, file_name, page_start, page_end, heading, content, search_score FROM (
             SELECT * FROM vector_search(index => ${q(DOCS_INDEX)}, query_text => ${q(qt)}, num_results => ${REFERENCE_FETCH_PER_QUERY})
           )${ss ? ` WHERE lower(source_system) = ${q(ss.toLowerCase())}` : ''}`,
        );
        return rows.map((r): ReferenceChunk => ({
          chunk_id: String(r.chunk_id ?? ''),
          file_name: String(r.file_name ?? ''),
          page_start: r.page_start == null ? null : Number(r.page_start),
          page_end: r.page_end == null ? null : Number(r.page_end),
          heading: r.heading ?? null,
          content: String(r.content ?? ''),
          score: Number(r.search_score ?? 0),
        }));
      }),
    );
    const packed = packReferenceChunks(results, budgetChars);
    return { text: packed.text, sources: packed.sources };
  }

  // ---- reference-document grounding ---------------------------------------
  /** The volume directory that holds a source system's reference docs (a per-source-
   * system subfolder). Source-system names are constrained by their route, but
   * sanitize again here as defense-in-depth against path traversal. */
  private docsDir(sourceSystem?: string): string {
    const ss = (sourceSystem ?? '').trim() || DEFAULT_SOURCE_SYSTEM;
    const safe = ss.replace(/[^\w .&-]/g, '_');
    return `${DOCS_VOLUME}/${safe}`;
  }

  /**
   * Reference passages relevant to mapping `targetTable`, retrieved from the Vector
   * Search index over parsed reference PDFs — or empty if no index is configured or
   * retrieval fails. Best-effort by design: grounding must never break a mapping.
   */
  private async loadReferenceContext(targetTable: string, sourceColumns: string[], sourceSystem?: string, maxQueryColumns: number = 40, maxContextChars: number = MAX_REFERENCE_CONTEXT_CHARS, targetColumns: string[] = []): Promise<{ text: string; sources: ReferenceSource[] }> {
    if (!DOCS_INDEX.trim()) return { text: '', sources: [] };
    try {
      return await this.loadReferenceChunks(targetTable, targetColumns, sourceColumns.slice(0, maxQueryColumns), sourceSystem, maxContextChars);
    } catch (e) {
      // Index not ready / no access — proceed without grounding (never break a mapping).
      console.warn(`[aimapper] reference chunk retrieval failed: ${errMsg(e)}`);
      return { text: '', sources: [] };
    }
  }

  /**
   * A service-principal WorkspaceClient (default env auth in a deployed App). Used
   * where a user token can't work: role-group membership (needs the `scim` scope,
   * which apps can't request) and the principals fallback. Cached after first use.
   */
  private spClient: WorkspaceClient | null = null;
  private serviceClient(): WorkspaceClient {
    if (!this.spClient) this.spClient = new WorkspaceClient({}); // {} = default env auth (SP)
    return this.spClient;
  }

  // ---- routes -------------------------------------------------------------
  injectRoutes(router: IAppRouter): void {
    // Run a handler's work inside the user's OBO context. Any thrown error is
    // turned into a 500 with its message.
    const handle = (
      req: IAppRequest,
      res: IAppResponse,
      work: () => Promise<unknown>,
    ): Promise<void> =>
      this.asUser(req)
        .inUserScope(async () => {
          await this.refreshDefaultSourceSystem();
          return work();
        })
        .then((body) => {
          if (!res.headersSent) res.json(body);
        })
        .catch((e: unknown) => {
          if (res.headersSent) return;
          if (e instanceof ForbiddenError) { res.status(403).json({ error: errMsg(e) }); return; }
          // A missing OBO scope (e.g. `files`, added after the user first consented)
          // surfaces as a raw "does not have required scopes" error. Translate it into
          // an actionable re-authorization message instead of the cryptic API string.
          const scope = missingScope(errMsg(e));
          if (scope) {
            res.status(403).json({
              error:
                `Your sign-in needs the '${scope}' permission, which was added since you last authorized this app. ` +
                `Please sign out and back in (or open the app in a new session) to re-authorize, then try again.`,
              needsReauth: true,
              missingScope: scope,
            });
            return;
          }
          res.status(500).json({ error: errMsg(e) });
        });

    const get = (name: string, path: string, work: (req: IAppRequest, res: IAppResponse) => Promise<unknown>) =>
      this.route(router, { name, method: 'get', path, handler: (req, res) => handle(req, res, () => work(req, res)) });
    const post = (name: string, path: string, work: (req: IAppRequest, res: IAppResponse) => Promise<unknown>) =>
      this.route(router, { name, method: 'post', path, handler: (req, res) => handle(req, res, () => work(req, res)) });
    const put = (name: string, path: string, work: (req: IAppRequest, res: IAppResponse) => Promise<unknown>) =>
      this.route(router, { name, method: 'put', path, handler: (req, res) => handle(req, res, () => work(req, res)) });
    const del = (name: string, path: string, work: (req: IAppRequest, res: IAppResponse) => Promise<unknown>) =>
      this.route(router, { name, method: 'delete', path, handler: (req, res) => handle(req, res, () => work(req, res)) });

    // 1. Catalogs.
    get('catalogs', '/catalogs', async () => {
      const ctx = this.ctx();
      const out: string[] = [];
      for await (const c of ctx.client.catalogs.list({})) if (c.name) out.push(c.name);
      return { catalogs: out.sort() };
    });

    // 2. Schemas.
    get('schemas', '/schemas', async (req, res) => {
      const catalog = qstr(req.query.catalog);
      if (!catalog) { res.status(400).json({ error: 'catalog is required' }); return undefined; }
      const ctx = this.ctx();
      const out: string[] = [];
      for await (const s of ctx.client.schemas.list({ catalog_name: catalog })) if (s.name) out.push(s.name);
      return { schemas: out.sort() };
    });

    // 3. Tables.
    get('tables', '/tables', async (req, res) => {
      const catalog = qstr(req.query.catalog);
      const schema = qstr(req.query.schema);
      if (!catalog || !schema) { res.status(400).json({ error: 'catalog and schema are required' }); return undefined; }
      const ctx = this.ctx();
      const out: string[] = [];
      for await (const t of ctx.client.tables.list({ catalog_name: catalog, schema_name: schema })) if (t.name) out.push(t.name);
      return { tables: out.sort() };
    });

    // 4. LLM serving endpoints (chat task only, excluding Responses-only models).
    get('endpoints', '/endpoints', async () => {
      // Chat endpoints the current user can actually QUERY (not merely see): the OBO
      // list filtered by per-endpoint CAN_QUERY/CAN_MANAGE, cached per user, fail-open
      // when permissions can't be read. See queryableEndpoints().
      const out = await this.queryableEndpoints();
      return { endpoints: out.slice().sort((a, b) => a.name.localeCompare(b.name)) };
    });

    // 5. target contract.
    get('target-entities', '/target-entities', async (req) => ({ targets: await this.loadTargetEntities(qstr(req.query.version) || undefined) }));

    // 5-dash. Coverage & quality dashboard aggregates.
    get('dashboard-stats', '/dashboard-stats', async (req) => {
      this.assertCatalog();
      await this.ensureHistoryColumns();
      await this.ensureProjectsTable();
      await this.ensureVendorsTable();

      // Optional project scope — all run/coverage/approval/feedback metrics narrow to it.
      const projectId = qstr(req.query.projectId);
      // A row's effective project (legacy NULL folds into its source system's default).
      const effProject = `coalesce(project_id, concat('default::', lower(coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)}))))`;
      const projAnd = projectId ? ` AND ${effProject} = ${q(projectId)}` : '';
      const projWhere = projectId ? ` WHERE ${effProject} = ${q(projectId)}` : '';
      // Feedback: project's own votes + global (null-project) votes when scoped.
      const fbWhere = projectId ? ` WHERE (project_id = ${q(projectId)} OR project_id IS NULL)` : '';

      // Reads are independent — run concurrently to collapse warehouse round-trips.
      const latestSql =
        `WITH ranked AS (
           SELECT target_table, status, match_confidence, mappings_json, version, created_at,
                  ROW_NUMBER() OVER (PARTITION BY target_table ORDER BY version DESC NULLS LAST, created_at DESC) AS rn
           FROM ${HISTORY_TABLE} WHERE target_table IS NOT NULL${projAnd}
         )
         SELECT target_table, status, match_confidence, mappings_json FROM ranked WHERE rn = 1`;
      // Coverage by source system: latest mapping per (source system, target).
      const bySourceSystemSql =
        `WITH ranked AS (
           SELECT coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)}) AS source_system, target_table, status, match_confidence, version, created_at,
                  ROW_NUMBER() OVER (PARTITION BY coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)}), target_table ORDER BY version DESC NULLS LAST, created_at DESC) AS rn
           FROM ${HISTORY_TABLE} WHERE target_table IS NOT NULL${projAnd}
         )
         SELECT source_system,
                COUNT(DISTINCT CASE WHEN status IN ('SUCCESS','WARNINGS') THEN target_table END) AS mapped_targets,
                AVG(CASE WHEN status IN ('SUCCESS','WARNINGS') THEN match_confidence END) AS avg_conf
         FROM ranked WHERE rn = 1 GROUP BY source_system ORDER BY source_system`;
      // Token usage: lifetime + last-7-day totals, and a 30-day daily trend.
      const tokenTotalsSql =
        `SELECT SUM(coalesce(total_tokens,0)) AS total,
                SUM(CASE WHEN created_at >= date_sub(current_date(), 7) THEN coalesce(total_tokens,0) ELSE 0 END) AS last7
         FROM ${HISTORY_TABLE}${projWhere}`;
      const tokenTrendSql =
        `SELECT date(created_at) AS d,
                SUM(coalesce(prompt_tokens,0)) AS prompt, SUM(coalesce(completion_tokens,0)) AS completion
         FROM ${HISTORY_TABLE} WHERE created_at >= date_sub(current_date(), 29)${projAnd}
         GROUP BY date(created_at) ORDER BY d`;
      const [targets, latest, statusRows, refRows, sourceSystems, bySys, approvalRows, fbRows, projCount, vendorCount, tokTot, tokTrend] = await Promise.all([
        this.loadTargetEntities(),
        this.runQuery(latestSql).catch(() => [] as Record<string, string | null>[]),
        this.runQuery(`SELECT status, COUNT(*) AS n FROM ${HISTORY_TABLE}${projWhere} GROUP BY status`).catch(() => [] as Record<string, string | null>[]),
        this.runQuery(
          `SELECT target_table, COUNT(*) AS n FROM ${EXAMPLES_TABLE} WHERE approved = true${projAnd} GROUP BY target_table ORDER BY n DESC LIMIT 5`,
        ).catch(() => [] as Record<string, string | null>[]),
        this.listSourceSystems().catch(() => [] as string[]),
        this.runQuery(bySourceSystemSql).catch(() => [] as Record<string, string | null>[]),
        this.runQuery(`SELECT lower(coalesce(approval_status,'in_review')) AS st, COUNT(*) AS n FROM ${HISTORY_TABLE}${projWhere} GROUP BY lower(coalesce(approval_status,'in_review'))`).catch(() => [] as Record<string, string | null>[]),
        this.runQuery(`SELECT SUM(CASE WHEN vote='up' THEN 1 ELSE 0 END) AS up, SUM(CASE WHEN vote='down' THEN 1 ELSE 0 END) AS down FROM ${FEEDBACK_TABLE}${fbWhere}`).catch(() => [{ up: '0', down: '0' }] as Record<string, string | null>[]),
        this.runQuery(`SELECT COUNT(*) AS n FROM ${PROJECTS_TABLE} WHERE coalesce(archived, false) = false`).catch(() => [{ n: '0' }] as Record<string, string | null>[]),
        this.runQuery(`SELECT COUNT(*) AS n FROM ${VENDORS_TABLE}`).catch(() => [{ n: '0' }] as Record<string, string | null>[]),
        this.runQuery(tokenTotalsSql).catch(() => [{ total: '0', last7: '0' }] as Record<string, string | null>[]),
        this.runQuery(tokenTrendSql).catch(() => [] as Record<string, string | null>[]),
      ]);

      const totalTargets = targets.length;
      const totalTargetColumns = targets.reduce((n, t) => n + t.columns.length, 0);

      const mappedTargets = new Set(latest.filter((r) => r.status === 'SUCCESS' || r.status === 'WARNINGS').map((r) => r.target_table));
      // Count mapped target columns from the latest mappings_json per target.
      let mappedColumns = 0;
      for (const r of latest) {
        if (!(r.status === 'SUCCESS' || r.status === 'WARNINGS')) continue;
        try {
          const ms = JSON.parse(r.mappings_json ?? '[]') as { source_table?: string | null; source_column?: string | null }[];
          mappedColumns += ms.filter((m) => m.source_table && m.source_column).length;
        } catch { /* skip unparseable */ }
      }

      // Per-target confidence = mean of the mapped columns' confidences in the
      // latest mappings_json, falling back to the stored match_confidence column.
      const confByTarget = new Map<string, number | null>();
      for (const r of latest) {
        let conf: number | null = null;
        try {
          const ms = JSON.parse(r.mappings_json ?? '[]') as { source_table?: string | null; source_column?: string | null; confidence?: number }[];
          const mapped = ms.filter((m) => m.source_table && m.source_column);
          if (mapped.length) conf = mapped.reduce((s, m) => s + (Number(m.confidence) || 0), 0) / mapped.length;
        } catch { /* ignore */ }
        if (conf == null && r.match_confidence != null && r.match_confidence !== '') conf = Number(r.match_confidence);
        confByTarget.set(r.target_table ?? '', conf);
      }
      const confVals = [...confByTarget.values()].filter((v): v is number => v != null);
      const avgConfidence: number | null = confVals.length ? confVals.reduce((a, b) => a + b, 0) / confVals.length : null;

      const statusCounts: Record<string, number> = {};
      let totalRuns = 0;
      for (const r of statusRows) { statusCounts[r.status ?? 'UNKNOWN'] = intOr(r.n ?? null, 0); totalRuns += intOr(r.n ?? null, 0); }

      const topReferences = refRows.map((r) => ({ target_table: r.target_table ?? '', count: intOr(r.n ?? null, 0) }));

      // Approval-workflow breakdown (draft is folded into in_review).
      const approvalCounts: Record<string, number> = {};
      for (const r of approvalRows) approvalCounts[(r.st ?? 'in_review')] = intOr(r.n ?? null, 0);
      const approval = {
        in_review: (approvalCounts['in_review'] ?? 0) + (approvalCounts['draft'] ?? 0),
        approved: approvalCounts['approved'] ?? 0,
        rejected: approvalCounts['rejected'] ?? 0,
      };

      // Coverage by source system (mapped target count + mean confidence).
      const bySourceSystem = bySys.map((r) => ({
        source_system: r.source_system ?? '',
        mappedTargets: intOr(r.mapped_targets ?? null, 0),
        avgConfidence: r.avg_conf != null && r.avg_conf !== '' ? Number(r.avg_conf) : null,
      }));

      const feedback = { up: intOr(fbRows[0]?.up ?? null, 0), down: intOr(fbRows[0]?.down ?? null, 0) };
      const portfolio = {
        projects: intOr(projCount[0]?.n ?? null, 0),
        sourceSystems: sourceSystems.length,
        vendors: intOr(vendorCount[0]?.n ?? null, 0),
      };
      const tokens = {
        total: intOr(tokTot[0]?.total ?? null, 0),
        last7: intOr(tokTot[0]?.last7 ?? null, 0),
      };
      // Daily token trend split into prompt vs completion (for a stacked bar). Label
      // as MM/DD for a compact x-axis.
      const tokenTrend = tokTrend.map((r) => ({
        date: String(r.d ?? '').slice(5).replace('-', '/'),
        prompt: intOr(r.prompt ?? null, 0),
        completion: intOr(r.completion ?? null, 0),
      }));

      const latestByTarget = new Map(latest.map((r) => [r.target_table, r]));
      const perTarget = targets.map((t) => {
        const l = latestByTarget.get(t.target_table);
        return {
          target_table: t.target_table,
          columns: t.columns.length,
          status: l?.status ?? 'UNMAPPED',
          confidence: confByTarget.get(t.target_table) ?? null,
        };
      });

      return {
        totalTargets,
        mappedTargets: mappedTargets.size,
        coveragePct: totalTargets ? Math.round((mappedTargets.size / totalTargets) * 100) : 0,
        totalTargetColumns,
        mappedColumns,
        unmappedColumns: Math.max(0, totalTargetColumns - mappedColumns),
        totalRuns,
        statusCounts,
        avgConfidence,
        topReferences,
        perTarget,
        portfolio,
        approval,
        bySourceSystem,
        feedback,
        tokens,
        tokenTrend,
      };
    });

    // 5a. Config: current target-schema table.
    get('config', '/config', async () => {
      this.assertCatalog();
      const current = await this.targetSchemaTable();
      return { targetSchemaTable: current, defaultTargetSchemaTable: DEFAULT_TARGET_SCHEMA_TABLE, isDefault: current === DEFAULT_TARGET_SCHEMA_TABLE };
    });

    // 5b. Config: validate a candidate target-schema table (does it hold target-schema metadata?).
    post('config-validate', '/config/validate', async (req, res) => {
      const { catalog, schema, table } = req.body as { catalog: string; schema: string; table: string };
      if (!catalog || !schema || !table) { res.status(400).json({ error: 'catalog, schema, table are required' }); return undefined; }
      return await this.validateTargetSchemaTable(`${catalog}.${schema}.${table}`);
    });

    // 5b2. Preview the top rows of the currently-configured target-schema table
    // (or a given fully-qualified table). Read-only, capped at 100 rows.
    get('target-schema-preview', '/target-schema-preview', async (req) => {
      this.assertCatalog();
      const requested = qstr(req.query.table).trim();
      const fq = requested || (await this.targetSchemaTable());
      // Only a plain catalog.schema.table identifier — no injection via query param.
      if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(fq)) {
        return { table: fq, columns: [], rows: [], error: 'Invalid table identifier.' };
      }
      const resp = await this.execStatement(`SELECT * FROM ${fq} LIMIT 100`);
      if (resp.status?.state !== 'SUCCEEDED') {
        return { table: fq, columns: [], rows: [], error: resp.status?.error?.message ?? `Statement state: ${resp.status?.state}` };
      }
      const columns = (resp.manifest?.schema?.columns ?? []).map((c) => c.name ?? '');
      const rows = (resp.result?.data_array ?? []).map((r) => r.map((v) => (v == null ? null : String(v))));
      return { table: fq, columns, rows };
    });

    // 5c. Config: save the target-schema table (validated, then upserted).
    post('config-save', '/config', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('admin');
      const { catalog, schema, table } = req.body as { catalog: string; schema: string; table: string };
      if (!catalog || !schema || !table) { res.status(400).json({ error: 'catalog, schema, table are required' }); return undefined; }
      const fq = `${catalog}.${schema}.${table}`;
      const check = await this.validateTargetSchemaTable(fq);
      if (!check.ok) return { ok: false, message: check.message };
      await this.ensureConfigTable();
      const user = this.currentUser();
      // Single-row upsert on id='target_schema'.
      const resp = await this.execStatement(
        `MERGE INTO ${CONFIG_TABLE} t USING (SELECT 'target_schema' AS id, ${q(fq)} AS target_schema_table, ${q(user)} AS updated_by) s
         ON t.id = s.id
         WHEN MATCHED THEN UPDATE SET t.target_schema_table = s.target_schema_table, t.updated_at = CURRENT_TIMESTAMP(), t.updated_by = s.updated_by
         WHEN NOT MATCHED THEN INSERT (id, target_schema_table, updated_at, updated_by) VALUES (s.id, s.target_schema_table, CURRENT_TIMESTAMP(), s.updated_by)`,
      );
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Save failed');
      this.invalidateCache('target-schema:'); // configured target-schema table changed → drop cached contract
      return { ok: true, message: check.message, targetSchemaTable: fq, targetCount: check.targetCount };
    });

    // 5d. schema versions: list (any role — drives the Mapper version selector).
    get('schema-versions', '/schema-versions', async () => {
      this.assertCatalog();
      await this.ensureSchemaVersionsTable();
      const rows = await this.runQuery(
        `SELECT version_id, label, target_schema_table, description, coalesce(is_default, false) AS is_default, created_by, created_at, updated_at
         FROM ${SCHEMA_VERSIONS_TABLE} ORDER BY coalesce(is_default, false) DESC, label`,
      );
      return { versions: rows };
    });

    // 5e. schema versions: create (admin). Validates the table holds target-schema metadata.
    post('schema-versions-create', '/schema-versions', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('admin');
      await this.ensureSchemaVersionsTable();
      const { label, catalog, schema, table, description, isDefault } = (req.body ?? {}) as {
        label?: string; catalog?: string; schema?: string; table?: string; description?: string; isDefault?: boolean;
      };
      const cleanLabel = (label ?? '').trim();
      if (!cleanLabel) { res.status(400).json({ error: 'A version label is required.' }); return undefined; }
      if (cleanLabel.length > 60) { res.status(400).json({ error: 'Label must be ≤60 characters.' }); return undefined; }
      if (!catalog || !schema || !table) { res.status(400).json({ error: 'catalog, schema, table are required' }); return undefined; }
      const fq = `${catalog}.${schema}.${table}`;
      const check = await this.validateTargetSchemaTable(fq);
      if (!check.ok) return { ok: false, message: check.message };
      const dup = await this.runQuery(`SELECT version_id FROM ${SCHEMA_VERSIONS_TABLE} WHERE lower(label) = ${q(cleanLabel.toLowerCase())} LIMIT 1`);
      if (dup.length) { res.status(409).json({ error: `A schema version labelled '${cleanLabel}' already exists.` }); return undefined; }
      const versionId = crypto.randomUUID();
      const makeDefault = isDefault === true;
      if (makeDefault) await this.execStatement(`UPDATE ${SCHEMA_VERSIONS_TABLE} SET is_default = false WHERE coalesce(is_default,false) = true`);
      const resp = await this.execStatement(
        `INSERT INTO ${SCHEMA_VERSIONS_TABLE} (version_id, label, target_schema_table, description, is_default, created_by, created_at, updated_at)
         VALUES (:vid, :label, ${q(fq)}, :description, ${makeDefault ? 'true' : 'false'}, ${q(this.currentUser())}, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
        [
          { name: 'vid', value: versionId },
          { name: 'label', value: cleanLabel },
          { name: 'description', value: (description ?? '').trim() || null },
        ],
      );
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Create failed');
      this.invalidateCache('target-schema:'); // schema versions changed → drop cached contracts
      return { ok: true, versionId, message: check.message, targetCount: check.targetCount };
    });

    // 5f. schema versions: update the target table / description / label / default (admin).
    put('schema-versions-update', '/schema-versions', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('admin');
      await this.ensureSchemaVersionsTable();
      const { versionId, label, catalog, schema, table, description, isDefault } = (req.body ?? {}) as {
        versionId?: string; label?: string; catalog?: string; schema?: string; table?: string; description?: string; isDefault?: boolean;
      };
      const vid = (versionId ?? '').trim();
      if (!vid) { res.status(400).json({ error: 'versionId is required' }); return undefined; }
      const sets: string[] = [];
      const params: { name: string; value: string | null }[] = [];
      // Optional table change — validated when provided.
      if (catalog && schema && table) {
        const fq = `${catalog}.${schema}.${table}`;
        const check = await this.validateTargetSchemaTable(fq);
        if (!check.ok) return { ok: false, message: check.message };
        sets.push(`target_schema_table = ${q(fq)}`);
      }
      if (label !== undefined) {
        const cleanLabel = (label ?? '').trim();
        if (!cleanLabel) { res.status(400).json({ error: 'Label cannot be empty.' }); return undefined; }
        sets.push('label = :label'); params.push({ name: 'label', value: cleanLabel });
      }
      if (description !== undefined) { sets.push('description = :description'); params.push({ name: 'description', value: (description ?? '').trim() || null }); }
      if (isDefault === true) {
        await this.execStatement(`UPDATE ${SCHEMA_VERSIONS_TABLE} SET is_default = false WHERE coalesce(is_default,false) = true`);
        sets.push('is_default = true');
      }
      if (sets.length === 0) { res.status(400).json({ error: 'Nothing to update.' }); return undefined; }
      sets.push('updated_at = CURRENT_TIMESTAMP()');
      const resp = await this.execStatement(`UPDATE ${SCHEMA_VERSIONS_TABLE} SET ${sets.join(', ')} WHERE version_id = ${q(vid)}`, params.length ? params : undefined);
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Update failed');
      this.invalidateCache('target-schema:'); // schema version changed → drop cached contracts
      return { ok: true };
    });

    // 5g. schema versions: delete (admin; keeps at least one; promotes a new default).
    del('schema-versions-delete', '/schema-versions', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('admin');
      await this.ensureSchemaVersionsTable();
      const vid = (qstr(req.query.versionId) || (req.body as { versionId?: string })?.versionId || '').trim();
      if (!vid) { res.status(400).json({ error: 'versionId is required' }); return undefined; }
      const all = await this.runQuery(`SELECT version_id, coalesce(is_default,false) AS is_default FROM ${SCHEMA_VERSIONS_TABLE}`);
      if (all.length <= 1) { res.status(409).json({ error: 'Cannot delete the only schema version — create another first.' }); return undefined; }
      const wasDefault = all.find((r) => r.version_id === vid && String(r.is_default).toLowerCase() === 'true');
      const resp = await this.execStatement(`DELETE FROM ${SCHEMA_VERSIONS_TABLE} WHERE version_id = ${q(vid)}`);
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Delete failed');
      // If we removed the default, promote the earliest remaining version.
      if (wasDefault) {
        await this.execStatement(
          `MERGE INTO ${SCHEMA_VERSIONS_TABLE} t
           USING (SELECT version_id FROM ${SCHEMA_VERSIONS_TABLE} ORDER BY created_at LIMIT 1) s
           ON t.version_id = s.version_id
           WHEN MATCHED THEN UPDATE SET is_default = true`,
        ).catch(() => undefined);
      }
      this.invalidateCache('target-schema:'); // schema versions changed → drop cached contracts
      return { ok: true };
    });

    // 6. Source table column metadata.
    post('source-schemas', '/source-schemas', async (req, res) => {
      const { catalog, schema, tables } = req.body as { catalog: string; schema: string; tables: string[] };
      if (!catalog || !schema || !Array.isArray(tables)) {
        res.status(400).json({ error: 'catalog, schema, tables[] are required' }); return undefined;
      }
      return { sources: await this.sourceSchemas(catalog, schema, tables) };
    });

    // 7. Target-driven attribute discovery.
    post('match-attributes', '/match-attributes', async (req, res) => {
      const discoveryT0 = Date.now();
      const { endpoint, target, sources, sourceSystem, projectId } = req.body as {
        endpoint: string; target: TargetEntity; sources: SourceTable[]; sourceSystem?: string; projectId?: string;
      };
      if (!endpoint || !target || !Array.isArray(sources)) {
        res.status(400).json({ error: 'endpoint, target, sources[] are required' }); return undefined;
      }
      const ss = (sourceSystem ?? '').trim() || DEFAULT_SOURCE_SYSTEM;
      const pid = (projectId ?? '').trim() || defaultProjectId(ss);
      const discoveryTraceId = crypto.randomUUID();
      // Ensure the feedback table's project_id column exists so project-scoped
      // feedback loads on existing installs (best-effort inside loadFeedback too).
      await this.ensureFeedbackTable();
      const targetCols = target.columns.map((c) => c.target_column);
      const validCols = new Map(sources.map((s) => [s.table, new Set(s.columns.map((c) => c.name))]));
      // Steer discovery with prior user feedback (👍/👎) for this target+project, and
      // ground it in the reference documents (Vector Search passages), if configured.
      const lim = await this.loadPromptLimits();
      const allSourceCols = sources.flatMap((s) => s.columns.map((c) => c.name));
      // Endpoint selection: an explicit request wins; 'auto' routes by task size.
      const useEndpoint = await this.selectEndpoint(endpoint, { targetCols: target.columns.length, sourceCols: allSourceCols.length, sourceTables: sources.length, maxExampleChars: 0 });
      const [feedback, reference, instructions] = await Promise.all([
        this.loadFeedback(target.target_table, pid),
        this.loadReferenceContext(target.target_table, allSourceCols, ss, lim.maxReferenceQueryColumns, lim.maxReferenceContextChars, targetCols),
        this.loadSourceSystemInstructions(ss),
      ]);
      const referenceContext = reference.text;
      // Wide targets produce large JSON; a low token cap truncates it mid-array and the
      // parse fails. Give it plenty of room, and if a response still won't parse, retry —
      // a fresh generation usually comes back clean AND complete. Each retry uses a STRICT
      // parse so a truncated/corrupt response is regenerated rather than silently salvaged
      // into a partial result. Only after retries are exhausted do we fall back to the
      // tolerant repair, so a persistently-truncated response still yields usable mappings.
      // ── Bound the discovery prompt ──
      // Rendering every column of every selected table overflows the model context on
      // wide schemas (e.g. 320 tables ≈ 210k tokens). So: (1) pre-filter to the most
      // relevant tables (confirmed-feedback tables always kept), (2) pack them into
      // batches under a per-call char budget, (3) hard-guard each prompt against the
      // profile's maxPromptChars, (4) merge per-batch picks by confidence.
      const confirmedTables = (feedback ?? [])
        .filter((f) => f.up > f.down && !!f.source_table)
        .map((f) => f.source_table as string);
      const selection = rankSourceTables(target, sources, MAX_DISCOVERY_TABLES, confirmedTables);
      const skippedTables = [...selection.skipped];
      let batches = batchSourceTables(selection.kept, Math.min(DISCOVERY_BATCH_CHARS, lim.maxPromptChars));
      if (batches.length > MAX_DISCOVERY_BATCHES) {
        for (const b of batches.slice(MAX_DISCOVERY_BATCHES)) skippedTables.push(...b.map((s) => s.table));
        batches = batches.slice(0, MAX_DISCOVERY_BATCHES);
      }
      if (batches.length === 0) {
        res.status(400).json({ error: 'No readable source tables were provided for attribute discovery.' }); return undefined;
      }
      const msgChars = (m: { content: string }[]) => m.reduce((n, x) => n + x.content.length, 0);
      const batchMsgs = batches.map((b) => buildAttributeMatchPrompt(target, b, CONFIDENCE_THRESHOLD, feedback, referenceContext, instructions));
      const oversized = batchMsgs.findIndex((m) => msgChars(m) > lim.maxPromptChars);
      if (oversized !== -1) {
        const n = msgChars(batchMsgs[oversized]);
        throw new Error(
          `Attribute discovery prompt is too large (${Math.round(n / 1000)}k chars > ${Math.round(lim.maxPromptChars / 1000)}k limit for the current Prompt Sizing profile). ` + // reconstructed: tail cut off
          `Source table(s) ${batches[oversized].map((s) => s.table).join(', ')} are too wide for one request — deselect them or raise the Prompt Sizing profile (Admin → Prompt Sizing).`, // reconstructed: tail cut off
        );
      }

      type RawMapping = Partial<AttributeMapping & { unmatched?: boolean; composite?: boolean; composite_sources?: string[] }>;
      const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
        promptTokens: a.promptTokens + b.promptTokens,
        completionTokens: a.completionTokens + b.completionTokens,
        totalTokens: a.totalTokens + b.totalTokens,
      });
      // One discovery call (with strict-parse retry, then tolerant salvage) per batch.
      const runBatch = async (msgs: { role: 'system' | 'user'; content: string }[]) => {
        let parsed: { mappings?: RawMapping[] } | null = null;
        let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        let lastErr: unknown = null;
        let lastContent = '';
        for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
          const r = await this.invokeLlmWithUsage(useEndpoint, msgs, lim.identifyMaxTokens);
          usage = addUsage(usage, r.usage);
          lastContent = r.content;
          try { parsed = extractJson(r.content, { repair: false }) as { mappings?: RawMapping[] }; }
          catch (e) { lastErr = e; }
        }
        let salvaged = false;
        if (!parsed) {
          // Last resort: salvage whatever complete objects the final (truncated) response held.
          try {
            parsed = extractJson(lastContent, { repair: true }) as { mappings?: RawMapping[] };
            salvaged = true;
          } catch (e) { lastErr = e; }
        }
        if (!parsed) {
          return { ok: false as const, usage, error: `The model returned malformed attribute-matching output (${errMsg(lastErr)}).` };
        }
        const byTc = new Map((parsed.mappings ?? []).map((m) => [m.target_column, m]));
        const mappings: CandidateMapping[] = targetCols.map((tc) => {
          const item: RawMapping = byTc.get(tc) ?? {};
          const stbl = item.source_table ?? null;
          const scol = item.source_column ?? null;
          const conf = typeof item.confidence === 'number' ? item.confidence : 0;
          const ok = !item.unmatched && !!stbl && validCols.get(stbl)?.has(scol ?? '') === true && conf >= CONFIDENCE_THRESHOLD;
          return {
            target_column: tc,
            source_table: ok ? stbl : null,
            source_column: ok ? scol : null,
            confidence: ok ? conf : 0,
            // Composite (multi-column / transformed) targets can only be approximated by a
            // single source column, so the description must say so explicitly.
            rationale: annotateCompositeRationale(item.rationale, item.composite, item.composite_sources),
          };
        });
        return { ok: true as const, usage, mappings, salvaged };
      };

      const results = await mapWithConcurrency(batchMsgs, DISCOVERY_CONCURRENCY, async (m) => {
        try { return await runBatch(m); }
        catch (e) { return { ok: false as const, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, error: errMsg(e) }; }
      });
      const usage = results.reduce<TokenUsage>((u, r) => addUsage(u, r.usage), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      const succeeded = results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
      const failedBatches = results.length - succeeded.length;
      if (succeeded.length === 0) {
        const firstErr = results.find((r) => !r.ok) as { error?: string } | undefined;
        throw new Error(`${firstErr?.error ?? 'Attribute discovery failed.'} This usually clears on a retry — click Identify Mappings again.`);
      }
      const mappings: AttributeMapping[] = mergeBatchMappings(targetCols, succeeded.map((r) => r.mappings));
      // truncated: some batch response was truncated/partially recovered, or a batch
      // failed outright — some columns may be unmatched; the caller warns the user to re-run.
      const salvaged = succeeded.some((r) => r.salvaged) || failedBatches > 0;
      // ── Step log: discovery ──
      this.logStep({
        traceId: discoveryTraceId,
        targetTable: target.target_table,
        step: 'discovery',
        domain: ss,
        projectId: pid,
        durationMs: Date.now() - discoveryT0,
        endpointName: useEndpoint,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        details: {
          tablesSelected: sources.length,
          tablesSearched: batches.reduce((n, b) => n + b.length, 0),
          skippedTables: skippedTables.slice(0, 50),
          batches: batches.length,
          failedBatches,
          ranking: selection.ranking.slice(0, 20).map((r) => ({ table: r.table, score: Math.round(r.score * 10) / 10 })),
          promptCharsPerBatch: batches.map((b) => b.reduce((n, s) => n + s.columns.length * 30, 0)),
          targetColumns: target.columns.length,
          mappedColumns: mappings.filter((m) => m.source_table && m.source_column).length,
          truncated: salvaged,
        },
      });

      return {
        mappings,
        tokens: usage,
        truncated: salvaged,
        traceId: discoveryTraceId,
        discovery: {
          tablesSelected: sources.length,
          tablesSearched: batches.reduce((n, b) => n + b.length, 0),
          skippedTables,
          batches: batches.length,
          failedBatches,
        },
      };
    });

    // 7b. Feedback: record a 👍/👎 vote on a target↔source mapping (Feature 10).
    post('feedback', '/feedback', async (req, res) => {
      this.assertCatalog();
      const { targetTable, targetColumn, sourceTable, sourceColumn, vote, projectId } = req.body as {
        targetTable: string; targetColumn: string; sourceTable?: string | null; sourceColumn?: string | null; vote: 'up' | 'down'; projectId?: string;
      };
      if (!targetTable || !targetColumn || (vote !== 'up' && vote !== 'down')) {
        res.status(400).json({ error: 'targetTable, targetColumn, and vote (up|down) are required' }); return undefined;
      }
      await this.ensureFeedbackTable();
      const user = this.currentUser();
      const resp = await this.execStatement(
        `INSERT INTO ${FEEDBACK_TABLE} (target_table, target_column, source_table, source_column, vote, project_id, created_at, created_by)
         VALUES (${q(targetTable)}, ${q(targetColumn)}, ${q(sourceTable ?? null)}, ${q(sourceColumn ?? null)}, ${q(vote)}, ${q((projectId ?? '').trim() || null)}, CURRENT_TIMESTAMP(), ${q(user)})`,
      );
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Feedback insert failed');
      return { ok: true };
    });

    // 7c. Feedback: aggregated votes for a target (for inline transparency).
    get('feedback', '/feedback', async (req, res) => {
      this.assertCatalog();
      const targetTable = qstr(req.query.targetTable);
      if (!targetTable) { res.status(400).json({ error: 'targetTable is required' }); return undefined; }
      const projectId = qstr(req.query.projectId);
      return { feedback: await this.loadFeedback(targetTable, projectId || undefined) };
    });

    // 8. Generate ONE JOIN SELECT (few-shot guided).
    post('generate-join-sql', '/generate-join-sql', async (req, res) => {
      const genT0 = Date.now();
      const { endpoint, target, sources, mappings, sourceSystem, projectId, crossProject, userInstructions, priorSql, sampleData, sampleValues, traceId: clientTraceId } = req.body as {
        endpoint: string; target: TargetEntity; sources: SourceTable[]; mappings: AttributeMapping[]; traceId?: string;
        sourceSystem?: string; projectId?: string; crossProject?: boolean;
        userInstructions?: string; priorSql?: string;
        sampleData?: boolean; sampleValues?: number; // [DATA-SAMPLING] per-run toggle + sample size (values/column)
      };
      if (!endpoint || !target || !Array.isArray(sources) || !Array.isArray(mappings)) {
        res.status(400).json({ error: 'endpoint, target, sources[], mappings[] are required' }); return undefined;
      }
      const ss = (sourceSystem ?? '').trim() || DEFAULT_SOURCE_SYSTEM;
      const scope: RetrievalScope = {
        sourceSystem: ss,
        projectId: (projectId ?? '').trim() || defaultProjectId(ss),
        crossProject: crossProject === true,
      };
      // Ensure the examples table's project_id column exists so the lexical
      // (project-scoped) retrieval query works on existing installs.
      await this.ensureExamplesColumns();
      // Prompt Sizing profile (admin-selectable): drives output token budgets AND the
      // prompt/example/reference/sample size caps for this run.
      const lim = await this.loadPromptLimits();
      const mappedCols = mappings.map((m) => m.source_column).filter((c): c is string => !!c);
      let examples: MappingExample[] = [];
      // 'lexical' when VS isn't configured or returned nothing; 'vector_search' when
      // the semantic index produced the examples. Surfaced to the UI for transparency.
      let retrievalMethod: 'vector_search' | 'lexical' = VS_INDEX.trim() ? 'vector_search' : 'lexical';
      const genTraceId = (clientTraceId ?? '').trim() || crypto.randomUUID();
      const retrievalT0 = Date.now();
      try {
        // Semantic Vector Search over the whole approved corpus (examples + history)
        // when configured; otherwise the lexical fallback. Scoped to the current project
        // — or, with Cross-Project Learning on, to all projects of the same source
        // system — and packed within a bounded budget (not a fixed top-3).
        const r = await this.retrieveExamples(target.target_table, mappedCols, scope, lim.maxFewshotItems, lim.fewshotCharBudget);
        examples = r.examples;
        retrievalMethod = r.method;
      } catch {
        // examples table may not exist yet; proceed without them.
      }
      // ── Step log: retrieval ──
      this.logStep({
        traceId: genTraceId,
        targetTable: target.target_table,
        step: 'retrieval',
        domain: ss,
        projectId: scope.projectId,
        durationMs: Date.now() - retrievalT0,
        details: {
          method: retrievalMethod,
          examplesFound: examples.length,
          examples: examples.slice(0, 10).map((e) => ({
            id: e.example_id,
            target: e.target_table,
            source: e.source_signature,
            sqlLength: (e.generated_sql ?? '').length,
          })),
          crossProject: scope.crossProject,
          vsIndexConfigured: !!VS_INDEX.trim(),
        },
      });

      // Ground generation in the reference documents (Vector Search passages), if configured,
      // and steer it with the source system's admin/editor-authored mapping instructions.
      const [reference, sourceSystemInstructions] = await Promise.all([
        this.loadReferenceContext(target.target_table, mappedCols, ss, lim.maxReferenceQueryColumns, lim.maxReferenceContextChars, target.columns.map((c) => c.target_column)),
        this.loadSourceSystemInstructions(ss),
      ]);
      const referenceContext = reference.text;
      // Combine durable source-system instructions with the caller's per-run instructions
      // (a contextual tweak for THIS generation). Both are injected as guidance; the
      // per-run note is capped so it can't blow up the prompt.
      const perRun = (userInstructions ?? '').trim().slice(0, lim.maxPerRunInstructionChars);
      const instructions = [sourceSystemInstructions, perRun].filter(Boolean).join('\n\n');
      // [DATA-SAMPLING] Optionally sample a few real values per source column (per-run toggle).
      // Best-effort and NEVER persisted — it only ever enters the transient prompt below.
      // Runs via OBO runQuery, so UC permissions apply to the sampled data.
      let sampleContext = '';
      if (sampleData === true) {
        const usedTables = new Set(mappings.map((m) => m.source_table).filter((t): t is string => !!t));
        const sampled = sources.filter((s) => usedTables.has(s.table));
        try {
          sampleContext = await buildSampleContext((sql) => this.runQuery(sql), sampled, sampleValues, { charBudget: lim.sampleCharBudget, maxValueChars: lim.maxValueChars, maxValues: lim.maxSampleValues });
        } catch {
          sampleContext = ''; // sampling must never break generation
        }
      }
      // Prompt-size guard: keep the assembled prompt safely under the model context
      // (~4 chars/token; 600k chars ≈ 150k tokens, leaving headroom under a 200k window).
      // Rather than switch models, trim the biggest OPTIONAL blocks — data samples first,
      // then the few-shot examples — until it fits. Rarely triggers, but bounds worst cases.
      const priorSqlArg = (priorSql ?? '').trim() || undefined;
      const promptChars = (msgs: { content: string }[]) => msgs.reduce((n, m) => n + m.content.length, 0);
      let ex = examples;
      let sc = sampleContext;
      let promptTrimmed = false;
      const exampleLimits = { maxExampleSqlChars: lim.maxExampleSqlChars };
      let msgs = buildJoinSqlPrompt(target, sources, mappings, ex, referenceContext, instructions, priorSqlArg, sc, exampleLimits);
      if (promptChars(msgs) > lim.maxPromptChars && sc) {
        sc = '';
        promptTrimmed = true;
        msgs = buildJoinSqlPrompt(target, sources, mappings, ex, referenceContext, instructions, priorSqlArg, sc, exampleLimits);
      }
      while (promptChars(msgs) > lim.maxPromptChars && ex.length > 1) {
        ex = ex.slice(0, Math.max(1, Math.floor(ex.length / 2)));
        promptTrimmed = true;
        msgs = buildJoinSqlPrompt(target, sources, mappings, ex, referenceContext, instructions, priorSqlArg, sc, exampleLimits);
      }
      // Endpoint selection: explicit request wins; 'auto' routes by task size, using
      // the final example set's largest SQL as a complexity signal.
      const maxExampleChars = ex.reduce((m, e) => Math.max(m, (e.generated_sql ?? '').length), 0);
      const useGenEndpoint = await this.selectEndpoint(endpoint, { targetCols: target.columns.length, sourceCols: sources.reduce((n, s) => n + s.columns.length, 0), sourceTables: sources.length, maxExampleChars });
      // Only report selectedEndpoint when auto-routing actually happened (requested 'auto'),
      // so the UI can label it without needing to know the requested value.
      const autoRouted = (endpoint ?? '').trim().toLowerCase() === 'auto';
      const { content: raw, usage, finishReason, completionTokens } = await this.invokeLlmWithUsage(useGenEndpoint, msgs, lim.genMaxTokens);
      const sql = cleanSql(raw);
      // Truncation guard: if the completion hit the output ceiling, the SQL is cut
      // off mid-statement — surface a clear message instead of letting a partial
      // statement fail downstream validation with a confusing error. finish_reason is
      // null on some endpoints even when truncated, so completion_tokens is the
      // primary signal.
      const outputTruncated = completionTokens >= lim.genMaxTokens || finishReason === 'length';
      // ── Step log: generation ──
      const genDurationMs = Date.now() - genT0;
      const logGenStep = (extra: Record<string, unknown>) => this.logStep({
        traceId: genTraceId,
        targetTable: target.target_table,
        step: 'generation',
        domain: ss,
        projectId: scope.projectId,
        durationMs: genDurationMs,
        endpointName: useGenEndpoint,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        details: {
          promptChars: promptChars(msgs),
          promptTrimmed,
          requestedEndpoint: endpoint,
          selectedEndpoint: useGenEndpoint,
          autoRouted,
          examplesUsed: ex.length,
          examplesOriginal: examples.length,
          referenceUsed: referenceContext.length > 0,
          referenceContextChars: referenceContext.length,
          referenceSources: reference.sources,
          sampleDataUsed: sampleData === true,
          sampleContextChars: sc.length,
          sqlLength: sql.length,
          finishReason,
          genMaxTokens: lim.genMaxTokens,
          maxPromptChars: lim.maxPromptChars,
          priorSqlProvided: !!priorSqlArg,
          ...extra,
        },
      });

      if (outputTruncated) {
        logGenStep({ outputTruncated: true });
        return {
          sql, readOnly: false, examplesUsed: ex.length,
          examplesTruncated: ex.filter((e) => (e.generated_sql ?? '').length > lim.maxExampleSqlChars).length,
          referenceUsed: referenceContext.length > 0, referenceSources: reference.sources, promptTrimmed, retrievalMethod,
          crossProject: scope.crossProject, tokens: usage, selectedEndpoint: autoRouted ? useGenEndpoint : undefined, outputTruncated: true,
          traceId: genTraceId,
          message: `SQL generation hit the output token limit (${completionTokens} tokens) and was cut off. Increase the Prompt Sizing profile (Admin → Prompt sizing) to "Generous" and regenerate.`,
        };
      }
      // Warn when an injected example's SQL exceeded the per-example cap and was cut.
      const examplesTruncated = ex.filter((e) => (e.generated_sql ?? '').length > lim.maxExampleSqlChars).length;
      logGenStep({ outputTruncated: false, readOnly: isReadOnlySql(sql) });
      return { sql, readOnly: isReadOnlySql(sql), examplesUsed: ex.length, examplesTruncated, referenceUsed: referenceContext.length > 0, referenceSources: reference.sources, promptTrimmed, retrievalMethod, crossProject: scope.crossProject, tokens: usage, selectedEndpoint: autoRouted ? useGenEndpoint : undefined, traceId: genTraceId }; // reconstructed: tail after promptTrimmed cut off; assumed unchanged + traceId
    });

    // 9. Validate generated SQL: dry-run (LIMIT 0) + diff vs the target schema.
    post('validate-sql', '/validate-sql', async (req, res) => {
      const valT0 = Date.now();
      const { sql, target, traceId: clientTraceId } = req.body as { sql: string; target: TargetEntity; traceId?: string };
      if (!sql || !target) { res.status(400).json({ error: 'sql and target are required' }); return undefined; }
      if (!isReadOnlySql(sql)) {
        this.logStep({ traceId: clientTraceId ?? undefined, targetTable: target.target_table, step: 'validation', durationMs: Date.now() - valT0, details: { readOnly: false, compileOk: false, sqlLength: sql.length } }); // reconstructed: details cut off
        return { report: buildReport(false, [], 'SQL is not read-only; refusing to execute') };
      }
      const dryRun = `SELECT * FROM (\n${sql}\n) AS _automap_dryrun LIMIT 0`;
      const resp = await this.execStatement(dryRun);
      if (resp.status?.state !== 'SUCCEEDED') {
        const msg = resp.status?.error?.message ?? `Statement state: ${resp.status?.state}`;
        this.logStep({ traceId: clientTraceId ?? undefined, targetTable: target.target_table, step: 'validation', durationMs: Date.now() - valT0, details: { readOnly: true, compileOk: false, error: msg.slice(0, 2000), sqlLength: sql.length } }); // reconstructed: details cut off
        return { report: buildReport(false, [], msg) };
      }
      const cols: ResultColumn[] = (resp.manifest?.schema?.columns ?? []).map((c) => ({
        name: c.name ?? '',
        typeName: String(c.type_name ?? 'STRING'),
        typeText: c.type_text,
      }));
      const diffs = diffSchema(target.columns, cols);
      const report = buildReport(true, diffs);
      this.logStep({
        traceId: clientTraceId ?? undefined,
        targetTable: target.target_table,
        step: 'validation',
        durationMs: Date.now() - valT0,
        details: {
          readOnly: true,
          compileOk: true,
          status: report.status,
          matched: diffs.filter((d) => d.status === 'matched').length,
          typeMismatch: diffs.filter((d) => d.status === 'type_mismatch').length,
          nullabilityMismatch: diffs.filter((d) => d.status === 'nullability_mismatch').length,
          missing: diffs.filter((d) => d.status === 'missing').length,
          extra: diffs.filter((d) => d.status === 'extra').length,
          sqlLength: sql.length,
        },
      });
      return { report };
    });

    // 9b. Preview generated SQL: run it read-only with LIMIT 20 and return rows.
    post('preview-sql', '/preview-sql', async (req, res) => {
      const { sql } = req.body as { sql: string };
      if (!sql) { res.status(400).json({ error: 'sql is required' }); return undefined; }
      if (!isReadOnlySql(sql)) return { error: 'SQL is not read-only; refusing to execute' };
      const preview = `SELECT * FROM (\n${sql}\n) AS _automap_preview LIMIT 20`;
      const resp = await this.execStatement(preview);
      if (resp.status?.state !== 'SUCCEEDED') {
        return { error: resp.status?.error?.message ?? `Statement state: ${resp.status?.state}` };
      }
      const columns = (resp.manifest?.schema?.columns ?? []).map((c) => c.name ?? '');
      const rows = (resp.result?.data_array ?? []).map((r) => r.map((v) => (v == null ? null : String(v))));
      return { columns, rows };
    });

    // 10. Persist a run to history.
    post('save-run', '/save-run', async (req, res) => {
      this.assertCatalog();
      await this.ensureHistoryColumns();
      const { runId, endpoint, items, createdBy } = req.body as {
        runId: string; endpoint: string; items: RunItem[]; createdBy?: string;
      };
      if (!runId || !endpoint || !Array.isArray(items) || items.length === 0) {
        res.status(400).json({ error: 'runId, endpoint, items[] are required' }); return undefined;
      }
      const user = createdBy ?? this.currentUser();
      // Compute the next version per target table (max existing + 1).
      const versionByTarget = new Map<string, number>();
      for (const it of items) {
        const t = it.targetTable;
        if (!t || versionByTarget.has(t)) continue;
        try {
          const rows = await this.runQuery(
            `SELECT COALESCE(MAX(version), 0) AS v FROM ${HISTORY_TABLE} WHERE target_table = ${q(t)}`,
          );
          versionByTarget.set(t, intOr(rows[0]?.v ?? null, 0) + 1);
        } catch {
          versionByTarget.set(t, 1);
        }
      }
      // Build a parameterized multi-row INSERT. Every free-text/quote-bearing value
      // is bound via a `:pN_field` marker (NOT inline-escaped) so the Statement
      // Execution API can't strip embedded quotes — the bug that corrupted stored SQL.
      const params: { name: string; value: string | null; type?: string }[] = [];
      const rowSql: string[] = [];
      items.forEach((it, i) => {
        const version = it.targetTable ? (versionByTarget.get(it.targetTable) ?? 1) : null;
        const report = it.validationReport ? JSON.stringify(it.validationReport) : null;
        const sourceSystem = (it.sourceSystem ?? '').trim() || DEFAULT_SOURCE_SYSTEM;
        const project = (it.projectId ?? '').trim() || defaultProjectId(sourceSystem);
        // p(field, value) registers a bound param and returns its :marker.
        const p = (field: string, value: string | null): string => {
          const name = `p${i}_${field}`;
          params.push({ name, value });
          return `:${name}`;
        };
        rowSql.push(
          `(${p('run_id', runId)}, ${p('item_id', it.itemId)}, CURRENT_TIMESTAMP(), ${p('created_by', user)}, ` +
          `${p('source_catalog', it.sourceCatalog)}, ${p('source_schema', it.sourceSchema)}, ${p('source_table', it.sourceTable)}, ` +
          `${p('target_table', it.targetTable)}, ${p('endpoint_name', endpoint)}, ${p('match_method', it.matchMethod)}, ` +
          `${num(it.matchConfidence)}, ${p('match_rationale', it.matchRationale)}, ${p('generated_sql', it.generatedSql)}, ` +
          `${p('status', it.status)}, ${p('validation_report', report)}, ${p('error_message', it.errorMessage)}, ` +
          `${num(it.durationMs)}, ${p('mappings_json', it.mappingsJson ?? null)}, ${num(version)}, ` +
          `'in_review', NULL, NULL, NULL, ${p('domain', sourceSystem)}, ${p('project_id', project)}, ${num(it.promptTokens)}, ${num(it.completionTokens)}, ${num(it.totalTokens)})`,
        );
      });
      const insert = `INSERT INTO ${HISTORY_TABLE}
(run_id, item_id, created_at, created_by, source_catalog, source_schema, source_table, target_table, endpoint_name, match_method, match_confidence, match_rationale, generated_sql, status, validation_report, error_message, duration_ms, mappings_json, version, approval_status, reviewed_by, reviewed_at, review_note, domain, project_id, prompt_tokens, completion_tokens, total_tokens)
VALUES\n${rowSql.join(',\n')}`;
      const resp = await this.execStatement(insert, params);
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Insert failed');
      // Backfill step-log rows with the run_id / item_id so Genie queries can join
      // step details to saved runs. Fire-and-forget: linking is best-effort.
      const { traceIds } = req.body as { traceIds?: string[] };
      if (Array.isArray(traceIds) && traceIds.length > 0) {
        void (async () => {
          try {
            await this.ensureStepLogTable();
            const tids = traceIds.filter((t) => typeof t === 'string' && t).map((t) => q(t)).join(', ');
            for (const it of items) {
              if (!tids || !it.targetTable || !it.itemId) continue;
              await this.execStatement(
                `UPDATE ${STEP_LOG_TABLE} SET run_id = ${q(runId)}, item_id = ${q(it.itemId)}
                 WHERE trace_id IN (${tids}) AND target_table = ${q(it.targetTable)} AND run_id IS NULL`,
              );
            }
          } catch { /* best-effort */ }
        })();
      }

      return { ok: true, runId, inserted: items.length };
    });

    // 11. History list. Optional filters: status (validation), approval, source
    // system, and/or project.
    get('history', '/history', async (req) => {
      this.assertCatalog();
      await this.ensureHistoryColumns();
      await this.ensureProjectsTable();
      const status = qstr(req.query.status);
      const approval = qstr(req.query.approval);
      const sourceSystem = qstr(req.query.sourceSystem);
      const projectId = qstr(req.query.projectId);
      // Each row's effective project (legacy NULL project_id folds into the source
      // system's default project) — reused for the filter and the projects join.
      const effProject = `coalesce(h.project_id, concat('default::', lower(coalesce(h.domain, ${q(DEFAULT_SOURCE_SYSTEM)}))))`;
      const clauses: string[] = [];
      if (status) clauses.push(`h.status = ${q(status)}`);
      if (approval) clauses.push(`lower(coalesce(h.approval_status, 'in_review')) = ${q(approval.toLowerCase())}`);
      if (sourceSystem) clauses.push(`coalesce(h.domain, ${q(DEFAULT_SOURCE_SYSTEM)}) = ${q(sourceSystem)}`);
      if (projectId) clauses.push(`${effProject} = ${q(projectId)}`);
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = await this.runQuery(
        `SELECT h.run_id, h.item_id, h.created_at, h.created_by, h.source_catalog, h.source_schema, h.source_table, h.target_table,
                h.endpoint_name, h.match_method, h.match_confidence, h.status, h.error_message, h.duration_ms, h.version,
                h.approval_status, h.reviewed_by, h.reviewed_at, h.review_note,
                coalesce(h.domain, ${q(DEFAULT_SOURCE_SYSTEM)}) AS source_system,
                ${effProject} AS project_id, p.name AS project_name
         FROM ${HISTORY_TABLE} h LEFT JOIN ${PROJECTS_TABLE} p ON ${effProject} = p.project_id
         ${where} ORDER BY h.created_at DESC LIMIT 500`,
      );
      return { rows };
    });

    // 11b. Full history item detail by item_id — for reload-into-Mapper + lineage.
    get('history-detail', '/history-detail', async (req, res) => {
      this.assertCatalog();
      await this.ensureHistoryColumns();
      const itemId = qstr(req.query.itemId);
      if (!itemId) { res.status(400).json({ error: 'itemId is required' }); return undefined; }
      const rows = await this.runQuery(
        `SELECT run_id, item_id, created_at, created_by, source_catalog, source_schema, source_table, target_table,
                endpoint_name, match_method, match_confidence, match_rationale, generated_sql, status,
                validation_report, error_message, duration_ms, mappings_json, version,
                approval_status, reviewed_by, reviewed_at, review_note,
                coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)}) AS source_system,
                coalesce(project_id, concat('default::', lower(coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)})))) AS project_id,
                prompt_tokens, completion_tokens, total_tokens
         FROM ${HISTORY_TABLE} WHERE item_id = ${q(itemId)} LIMIT 1`,
      );
      return { item: rows[0] ?? null };
    });

    // 11c. Step log: read steps for a target, trace, or run.
    get('run-steps', '/run-steps', async (req, res) => {
      this.assertCatalog();
      await this.ensureStepLogTable();
      const target = qstr(req.query.targetTable);
      const traceId = qstr(req.query.traceId);
      const runId = qstr(req.query.runId);
      const clauses: string[] = [];
      if (target) clauses.push(`target_table = ${q(target)}`);
      if (traceId) clauses.push(`trace_id = ${q(traceId)}`);
      if (runId) clauses.push(`run_id = ${q(runId)}`);
      if (clauses.length === 0) { res.status(400).json({ error: 'At least one of targetTable, traceId, runId is required' }); return undefined; }
      const rows = await this.runQuery(
        `SELECT step_id, trace_id, run_id, item_id, target_table, step, domain, project_id,
                created_at, created_by, duration_ms, endpoint_name,
                prompt_tokens, completion_tokens, total_tokens, details
         FROM ${STEP_LOG_TABLE}
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC LIMIT 200`,
      );
      return { steps: rows };
    });

    // 12. History item detail.
    get('history-item', '/history-item', async (req, res) => {
      this.assertCatalog();
      const runId = qstr(req.query.runId);
      const sourceTable = qstr(req.query.sourceTable);
      if (!runId || !sourceTable) { res.status(400).json({ error: 'runId and sourceTable are required' }); return undefined; }
      const rows = await this.runQuery(
        `SELECT source_table, target_table, status, match_method, match_confidence, match_rationale,
                generated_sql, validation_report, error_message
         FROM ${HISTORY_TABLE} WHERE run_id = ${q(runId)} AND source_table = ${q(sourceTable)} LIMIT 1`,
      );
      return { item: rows[0] ?? null };
    });

    // 13. History delete by item_id (admin only).
    del('history-item-delete', '/history-item', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('admin');
      const itemId = qstr(req.query.itemId) || (req.body as { itemId?: string })?.itemId || '';
      if (!itemId) { res.status(400).json({ error: 'itemId is required' }); return undefined; }
      const resp = await this.execStatement(`DELETE FROM ${HISTORY_TABLE} WHERE item_id = ${q(itemId)}`);
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Delete failed');
      return { ok: true };
    });

    // 13a. Whoami — the signed-in user's email + resolved role (drives UI gating).
    get('whoami', '/whoami', async () => {
      this.assertCatalog();
      return { email: this.currentUser(), role: await this.currentRole() };
    });

    // 13a2. Per-user preferences: read the signed-in user's saved settings.
    get('user-prefs', '/user-prefs', async () => {
      this.assertCatalog();
      const email = this.currentUser().toLowerCase();
      try {
        await this.ensureUserPrefsTable();
        const rows = await this.runQuery(
          `SELECT default_endpoint, default_catalog, default_schema, default_target, theme
           FROM ${USER_PREFS_TABLE} WHERE lower(user_email) = ${q(email)} LIMIT 1`,
        );
        const r = rows[0];
        return {
          prefs: {
            defaultEndpoint: r?.default_endpoint ?? null,
            defaultCatalog: r?.default_catalog ?? null,
            defaultSchema: r?.default_schema ?? null,
            defaultTarget: r?.default_target ?? null,
            theme: r?.theme ?? null,
          },
        };
      } catch {
        // Table unreadable/missing → empty prefs (all defaults).
        return { prefs: { defaultEndpoint: null, defaultCatalog: null, defaultSchema: null, defaultTarget: null, theme: null } };
      }
    });

    // 13a3. Per-user preferences: upsert the signed-in user's settings (self only).
    post('user-prefs-save', '/user-prefs', async (req) => {
      this.assertCatalog();
      await this.ensureUserPrefsTable();
      const { defaultEndpoint, defaultCatalog, defaultSchema, defaultTarget, theme } = (req.body ?? {}) as {
        defaultEndpoint?: string | null; defaultCatalog?: string | null; defaultSchema?: string | null;
        defaultTarget?: string | null; theme?: string | null;
      };
      const email = this.currentUser();
      // Single-row upsert keyed on the user's own email (OBO — a user only ever
      // writes their own row; the identity comes from the forwarded token).
      const resp = await this.execStatement(
        `MERGE INTO ${USER_PREFS_TABLE} t
         USING (SELECT ${q(email)} AS user_email, ${q(defaultEndpoint ?? null)} AS default_endpoint,
                       ${q(defaultCatalog ?? null)} AS default_catalog, ${q(defaultSchema ?? null)} AS default_schema,
                       ${q(defaultTarget ?? null)} AS default_target, ${q(theme ?? null)} AS theme) s
         ON lower(t.user_email) = lower(s.user_email)
         WHEN MATCHED THEN UPDATE SET t.default_endpoint = s.default_endpoint, t.default_catalog = s.default_catalog,
              t.default_schema = s.default_schema, t.default_target = s.default_target, t.theme = s.theme,
              t.updated_at = CURRENT_TIMESTAMP()
         WHEN NOT MATCHED THEN INSERT (user_email, default_endpoint, default_catalog, default_schema, default_target, theme, updated_at)
              VALUES (s.user_email, s.default_endpoint, s.default_catalog, s.default_schema, s.default_target, s.theme, CURRENT_TIMESTAMP())`,
      );
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Save failed');
      return { ok: true };
    });

    // 13b. Approval transition for a history item (all editor+):
    //   approve (in_review -> approved)
    //   reject  (in_review -> rejected)
    //   reopen  (approved|rejected -> in_review)
    post('approval-transition', '/approval-transition', async (req, res) => {
      this.assertCatalog();
      await this.ensureHistoryColumns();
      await this.requireRole('editor');
      const { itemId, action, note } = req.body as {
        itemId: string; action: ApprovalAction; note?: string;
      };
      if (!itemId || !action) { res.status(400).json({ error: 'itemId and action are required' }); return undefined; }

      const rows = await this.runQuery(
        `SELECT approval_status FROM ${HISTORY_TABLE} WHERE item_id = ${q(itemId)} LIMIT 1`,
      );
      if (rows.length === 0) { res.status(404).json({ error: 'History item not found' }); return undefined; }

      const outcome = resolveTransition(rows[0]?.approval_status, action);
      if (!outcome.ok) { res.status(outcome.status).json({ error: outcome.error }); return undefined; }

      const user = this.currentUser();
      // Only decisions (approve/reject) stamp a reviewer; reopen clears the fields
      // so a re-review item carries no stale decision.
      const stampReviewer = stampsReviewer(action);
      const set = [
        `approval_status = ${q(outcome.to)}`,
        `reviewed_by = ${stampReviewer ? q(user) : 'NULL'}`,
        `reviewed_at = ${stampReviewer ? 'CURRENT_TIMESTAMP()' : 'NULL'}`,
        `review_note = ${q(note ?? null)}`,
      ].join(', ');
      const resp = await this.execStatement(
        `UPDATE ${HISTORY_TABLE} SET ${set} WHERE item_id = ${q(itemId)}`,
      );
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Transition failed');

      // Mirror approved runs into the retrieval corpus so approved history feeds
      // future generations; remove them when they leave the approved state.
      if (VS_INDEX) {
        if (outcome.to === 'approved') {
          const d = await this.runQuery(
            `SELECT target_table, source_table, source_catalog, source_schema, generated_sql,
                    coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)}) AS domain,
                    coalesce(project_id, concat('default::', lower(coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)})))) AS project_id
             FROM ${HISTORY_TABLE} WHERE item_id = ${q(itemId)} LIMIT 1`,
          ).catch(() => []);
          const it = d[0];
          if (it && it.target_table && it.generated_sql) {
            const sig = it.source_catalog && it.source_schema && it.source_table
              ? `${it.source_catalog}.${it.source_schema}.${it.source_table}` : (it.source_table ?? null);
            await this.upsertCorpusRow({
              id: `run:${itemId}`, kind: 'history', domain: it.domain ?? DEFAULT_SOURCE_SYSTEM,
              projectId: it.project_id ?? defaultProjectId(it.domain),
              targetTable: it.target_table, sourceSignature: sig, sourceColumns: null, generatedSql: it.generated_sql,
            });
          }
        } else if (outcome.from === 'approved') {
          await this.deleteCorpusRow(`run:${itemId}`);
        }
      }
      return { ok: true, from: outcome.from, to: outcome.to };
    });

    // 13c. Roles: role groups + their members (admin only). Membership is the
    // source of truth; ROLES_TABLE only adds "changed by / when" for in-app changes.
    get('roles', '/roles', async () => {
      this.assertCatalog();
      await this.requireRole('admin');
      await this.ensureRolesTable();
      let groups: Awaited<ReturnType<AiMapper['listRoleMembers']>>['groups'] = ROLE_ORDER.slice().reverse().map((r) => ({ role: r, name: ROLE_GROUPS[r], id: null, members: 0 }));
      let members: Awaited<ReturnType<AiMapper['listRoleMembers']>>['members'] = [];
      let error: string | null = null;
      try {
        ({ groups, members } = await this.listRoleMembers());
      } catch (e) {
        error = `Couldn't read the role groups: ${errMsg(e)}`;
      }
      const audit = await this.runQuery(
        `SELECT lower(user_email) AS k, coalesce(principal_type, 'user') AS t, updated_by, updated_at FROM ${ROLES_TABLE}`,
      ).catch(() => [] as Record<string, string | null>[]);
      const auditBy = new Map(audit.map((a) => [`${a.t}:${a.k}`, a]));
      // Groups whose permissions were applied in-app (ledger rows) and when.
      const applied = await this.runQuery(
        `SELECT lower(principal) AS p, count(*) AS n, max(granted_at) AS at FROM ${GRANTS_LEDGER_TABLE} WHERE principal_type = 'group' GROUP BY lower(principal)`,
      ).catch(() => [] as Record<string, string | null>[]);
      const appliedBy = new Map(applied.map((a) => [String(a.p), a]));
      return {
        groups: groups.map((g) => {
          const a = appliedBy.get(g.name.toLowerCase());
          return { ...g, grantsApplied: Number(a?.n ?? 0), lastAppliedAt: a?.at ?? null };
        }),
        members: members.map((m) => {
          const a = auditBy.get(`${m.kind === 'group' ? 'group' : 'user'}:${m.principal.toLowerCase()}`);
          return {
            principal: m.principal,
            principalType: m.kind,
            displayName: m.display,
            role: m.role,
            alsoIn: m.alsoIn,
            updatedBy: a?.updated_by ?? null,
            updatedAt: a?.updated_at ?? null,
          };
        }),
        bootstrapAdmins: [...BOOTSTRAP_ADMINS],
        error,
      };
    });

    // 13c2. Workspace users + groups for the role picker (admin only).
    get('principals', '/principals', async () => {
      this.assertCatalog();
      await this.requireRole('admin');
      return this.listWorkspacePrincipals();
    });

    // 13d. Roles: put a user/group in a role (admin only) = add them to that role's
    // group and remove them from the other role groups. No per-user grants: the role
    // groups already hold the permissions.
    post('roles-set', '/roles', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('admin');
      await this.ensureRolesTable();
      const { userEmail, role, principalType } = req.body as { userEmail?: string; role?: string; principalType?: string };
      const type: PrincipalKind = principalType === 'group' ? 'group' : 'user';
      const name = type === 'group' ? (userEmail ?? '').trim() : (userEmail ?? '').trim().toLowerCase();
      const r = (role ?? '').trim().toLowerCase();
      if (!name || !isRole(r)) {
        res.status(400).json({ error: 'userEmail and a valid role (viewer|editor|admin) are required' });
        return undefined;
      }
      const changes = await this.setRoleMembership(name, type, r);
      await this.execStatement(
        `MERGE INTO ${ROLES_TABLE} t
         USING (SELECT ${q(name)} AS user_email, ${q(r)} AS role, ${q(this.currentUser())} AS updated_by, CURRENT_TIMESTAMP() AS updated_at, ${q(type)} AS principal_type) s
         ON lower(t.user_email) = lower(s.user_email) AND coalesce(t.principal_type, 'user') = s.principal_type
         WHEN MATCHED THEN UPDATE SET t.role = s.role, t.updated_by = s.updated_by, t.updated_at = s.updated_at
         WHEN NOT MATCHED THEN INSERT (user_email, role, updated_by, updated_at, principal_type)
           VALUES (s.user_email, s.role, s.updated_by, s.updated_at, s.principal_type)`,
      ).catch(() => undefined); // audit only
      return { ok: true, userEmail: name, role: r, group: ROLE_GROUPS[r], changes };
    });

    // 13e. Roles: remove a user/group from every role group → default Viewer (admin only).
    del('roles-delete', '/roles', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('admin');
      await this.ensureRolesTable();
      const type: PrincipalKind = (qstr(req.query.principalType) || (req.body as { principalType?: string })?.principalType) === 'group' ? 'group' : 'user';
      const raw = (qstr(req.query.userEmail) || (req.body as { userEmail?: string })?.userEmail || '').trim();
      const name = type === 'group' ? raw : raw.toLowerCase();
      if (!name) { res.status(400).json({ error: 'userEmail is required' }); return undefined; }
      const changes = await this.setRoleMembership(name, type, null);
      await this.execStatement(
        `DELETE FROM ${ROLES_TABLE} WHERE lower(user_email) = ${q(name.toLowerCase())} AND coalesce(principal_type, 'user') = ${q(type)}`,
      ).catch(() => undefined);
      return { ok: true, changes };
    });

    // 13e2. Roles: grant each role group the resource permissions its role needs,
    // with the signed-in admin's identity (admin only). Idempotent — run at first
    // setup and again whenever the app's resources change.
    post('roles-provision', '/roles/provision', async () => {
      this.assertCatalog();
      await this.requireRole('admin');
      const ids = await this.roleGroupIds();
      const results: { role: Role; group: string; found: boolean; permissions: Awaited<ReturnType<AiMapper['syncRolePermissions']>> }[] = [];
      for (const r of ROLE_ORDER.slice().reverse()) {
        if (!ids[r]) { results.push({ role: r, group: ROLE_GROUPS[r], found: false, permissions: [] }); continue; }
        results.push({ role: r, group: ROLE_GROUPS[r], found: true, permissions: await this.syncRolePermissions(ROLE_GROUPS[r], 'group', r) });
      }
      return { results };
    });

    // 13f. Source systems: list (any role — drives the Mapper selector & filters).
    get('source-systems', '/source-systems', async () => {
      this.assertCatalog();
      const details = await this.listSourceSystemDetails().catch(() => [] as { name: string; description: string | null; isDefault: boolean }[]);
      return { sourceSystems: await this.listSourceSystems(), defaultSourceSystem: DEFAULT_SOURCE_SYSTEM, details };
    });

    // 13g. Source systems: create (admin only).
    post('source-systems-create', '/source-systems', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('admin');
      await this.ensureSourceSystemsTable();
      const { name, description } = (req.body ?? {}) as { name?: string; description?: string };
      const clean = (name ?? '').trim();
      if (!clean) { res.status(400).json({ error: 'A source system name is required.' }); return undefined; }
      if (clean.length > 60 || !/^[\w .&/-]+$/.test(clean)) {
        res.status(400).json({ error: 'Source system name must be ≤60 chars (letters, numbers, spaces, . & / - _).' });
        return undefined;
      }
      // Reject duplicates case-insensitively.
      const existing = await this.runQuery(`SELECT name FROM ${SOURCE_SYSTEMS_TABLE} WHERE lower(name) = ${q(clean.toLowerCase())} LIMIT 1`);
      if (existing.length) { res.status(409).json({ error: `Source system '${clean}' already exists.` }); return undefined; }
      const resp = await this.execStatement(
        `INSERT INTO ${SOURCE_SYSTEMS_TABLE} (name, description, created_by, created_at)
         VALUES (${q(clean)}, ${q(description ?? null)}, ${q(this.currentUser())}, CURRENT_TIMESTAMP())`,
      );
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Create failed');
      this.invalidateCache('sources:'); // source-system list changed
      return { ok: true, name: clean };
    });

    // 13g-2. Source systems: edit name and/or description (admin only). The default
    // FLAG is fixed, but the default's name is editable like any other. A rename is
    // applied everywhere the name is stored: runs, examples, step logs, retrieval
    // corpus, instructions, projects (incl. the default project's id/name), and the
    // reference documents (files move to the new folder; their indexed passages are
    // re-pointed, not re-parsed).
    put('source-systems-update', '/source-systems', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('admin');
      await this.ensureSourceSystemsTable();
      const body = (req.body ?? {}) as { name?: string; newName?: string; description?: string | null };
      const oldName = (body.name ?? '').trim();
      const newName = (body.newName ?? oldName).trim();
      if (!oldName) { res.status(400).json({ error: 'name is required' }); return undefined; }
      if (!newName || newName.length > 60 || !/^[\w .&/-]+$/.test(newName) || newName.includes('/')) {
        res.status(400).json({ error: 'Source system name must be ≤60 chars (letters, numbers, spaces, . & - _).' });
        return undefined;
      }
      const rows = await this.runQuery(`SELECT name, coalesce(is_default, false) AS is_default FROM ${SOURCE_SYSTEMS_TABLE} WHERE name = ${q(oldName)} LIMIT 1`);
      if (!rows.length) { res.status(404).json({ error: `Source system '${oldName}' not found.` }); return undefined; }
      const isDefault = String(rows[0].is_default).toLowerCase() === 'true';
      const renamed = newName !== oldName;
      if (renamed) {
        const dup = await this.runQuery(`SELECT name FROM ${SOURCE_SYSTEMS_TABLE} WHERE lower(name) = ${q(newName.toLowerCase())} AND name <> ${q(oldName)} LIMIT 1`);
        if (dup.length) { res.status(409).json({ error: `Source system '${dup[0].name}' already exists.` }); return undefined; }
      }
      const sets = [`name = ${q(newName)}`];
      if (body.description !== undefined) sets.push(`description = ${q((body.description ?? '').trim() || null)}`);
      await this.execStatement(`UPDATE ${SOURCE_SYSTEMS_TABLE} SET ${sets.join(', ')} WHERE name = ${q(oldName)}`);
      const warnings: string[] = [];
      if (renamed) {
        const o = q(oldName);
        const n = q(newName);
        const oldPid = q(defaultProjectId(oldName));
        const newPid = q(defaultProjectId(newName));
        // Legacy rows with no source system belong to the default — pin them to the
        // new name explicitly as part of renaming it.
        const domainMatch = isDefault ? `(domain = ${o} OR domain IS NULL)` : `domain = ${o}`;
        const step = async (label: string, sql: string) => {
          try { await this.runLongStatement(sql); } catch (e) { warnings.push(`${label}: ${errMsg(e).slice(0, 200)}`); }
        };
        for (const [label, table] of [['runs', HISTORY_TABLE], ['examples', EXAMPLES_TABLE], ['retrieval corpus', CORPUS_TABLE], ['step log', STEP_LOG_TABLE]] as const) {
          await step(label, `UPDATE ${table} SET domain = ${n}, project_id = CASE WHEN project_id = ${oldPid} THEN ${newPid} ELSE project_id END WHERE ${domainMatch} OR project_id = ${oldPid}`);
        }
        await step('instructions', `UPDATE ${SOURCE_SYSTEM_INSTRUCTIONS_TABLE} SET domain = ${n} WHERE domain = ${o}`);
        await step('projects', `UPDATE ${PROJECTS_TABLE} SET source_system = ${n} WHERE source_system = ${o}`);
        await step('default project',
          `UPDATE ${PROJECTS_TABLE} SET project_id = ${newPid},
             name = CASE WHEN name = ${q(`Default — ${oldName}`)} THEN ${q(`Default — ${newName}`)} ELSE name END
           WHERE project_id = ${oldPid}`);
        warnings.push(...(await this.moveReferenceDocs(oldName, newName)));
        if (isDefault) DEFAULT_SOURCE_SYSTEM = newName;
        if (VS_INDEX) {
          try { await this.ctx().client.vectorSearchIndexes.syncIndex({ index_name: VS_INDEX }); } catch { /* hourly job catches up */ }
        }
      }
      this.invalidateCache('sources:');
      this.invalidateCache('projects:');
      this.invalidateCache('refdocs:');
      return { ok: true, name: newName, isDefault, warnings };
    });

    // 13h. Source systems: delete (admin only; blocked when in use or for the default).
    del('source-systems-delete', '/source-systems', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('admin');
      await this.ensureSourceSystemsTable();
      const name = (qstr(req.query.name) || (req.body as { name?: string })?.name || '').trim();
      if (!name) { res.status(400).json({ error: 'name is required' }); return undefined; }
      const flagged = await this.runQuery(`SELECT 1 FROM ${SOURCE_SYSTEMS_TABLE} WHERE name = ${q(name)} AND coalesce(is_default, false) LIMIT 1`).catch(() => []);
      if (flagged.length || name.toLowerCase() === DEFAULT_SOURCE_SYSTEM.toLowerCase()) {
        res.status(409).json({ error: `'${name}' is the default source system and cannot be deleted.` }); return undefined;
      }
      // Block deletion when any run, example, or project still references it.
      const [runs, examples, projects] = await Promise.all([
        this.runQuery(`SELECT COUNT(*) AS n FROM ${HISTORY_TABLE} WHERE domain = ${q(name)}`).catch(() => [{ n: '0' }]),
        this.runQuery(`SELECT COUNT(*) AS n FROM ${EXAMPLES_TABLE} WHERE domain = ${q(name)}`).catch(() => [{ n: '0' }]),
        this.runQuery(`SELECT COUNT(*) AS n FROM ${PROJECTS_TABLE} WHERE source_system = ${q(name)}`).catch(() => [{ n: '0' }]),
      ]);
      const inUse = intOr(runs[0]?.n ?? null, 0) + intOr(examples[0]?.n ?? null, 0) + intOr(projects[0]?.n ?? null, 0);
      if (inUse > 0) {
        res.status(409).json({ error: `Cannot delete '${name}': ${inUse} project/history/reference record(s) still use it. Reassign or remove them first.` });
        return undefined;
      }
      const resp = await this.execStatement(`DELETE FROM ${SOURCE_SYSTEMS_TABLE} WHERE name = ${q(name)}`);
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Delete failed');
      this.invalidateCache('sources:'); // source-system list changed
      return { ok: true };
    });

    // 13f-2. Projects: list (any role — drives the Mapper project selector). Includes a
    // run count so admins can see which projects are in use before deleting.
    get('projects', '/projects', async () => {
      this.assertCatalog();
      await this.ensureProjectsTable();
      await this.ensureVendorsTable();
      await this.ensureSchemaVersionsTable();
      await this.ensureHistoryColumns();
      // Cached (short TTL) — the client fetches this on several navigations; collapses
      // the repeated identical reads. Invalidated on project create/update/delete; the
      // embedded history rollups can lag up to PROJECTS_CACHE_TTL_MS after a run.
      return this.cachedRead('projects:list', async () => {
      // Per-project rollups (run count, review backlog, approved, mapped targets, last
      // activity) for the Projects overview page. `eff` folds legacy NULL project_id
      // into the source system's default project.
      const eff = `coalesce(h.project_id, concat('default::', lower(coalesce(h.domain, ${q(DEFAULT_SOURCE_SYSTEM)}))))`;
      const rows = await this.runQuery(
        `SELECT p.project_id, p.name, p.description, p.source_system, p.vendor_code,
                v.name AS vendor_name, coalesce(p.schema_version_id, ${q(DEFAULT_SCHEMA_VERSION_ID)}) AS schema_version_id,
                pv.label AS schema_version_label, p.created_by, p.created_at,
                coalesce(p.archived, false) AS archived,
                (SELECT COUNT(*) FROM ${HISTORY_TABLE} h WHERE ${eff} = p.project_id) AS run_count,
                (SELECT COUNT(*) FROM ${HISTORY_TABLE} h WHERE ${eff} = p.project_id AND lower(coalesce(h.approval_status,'in_review')) = 'in_review') AS in_review,
                (SELECT COUNT(*) FROM ${HISTORY_TABLE} h WHERE ${eff} = p.project_id AND lower(coalesce(h.approval_status,'in_review')) = 'approved') AS approved,
                (SELECT COUNT(DISTINCT h.target_table) FROM ${HISTORY_TABLE} h WHERE ${eff} = p.project_id AND h.status IN ('SUCCESS','WARNINGS')) AS mapped_targets,
                (SELECT MAX(h.created_at) FROM ${HISTORY_TABLE} h WHERE ${eff} = p.project_id) AS last_activity
         FROM ${PROJECTS_TABLE} p
         LEFT JOIN ${VENDORS_TABLE} v ON p.vendor_code = v.vendor_code
         LEFT JOIN ${SCHEMA_VERSIONS_TABLE} pv ON coalesce(p.schema_version_id, ${q(DEFAULT_SCHEMA_VERSION_ID)}) = pv.version_id
         WHERE coalesce(p.archived, false) = false
         ORDER BY p.created_at DESC, p.name`,
      );
      // Total target entities (default version) so the client can show coverage %.
      const totalTargets = await this.loadTargetEntities().then((t) => t.length).catch(() => 0);
      return { projects: rows, defaultSourceSystem: DEFAULT_SOURCE_SYSTEM, totalTargets };
      }, PROJECTS_CACHE_TTL_MS);
    });

    // 13f-3. Projects: create (editor+). One source system per project; an optional
    // vendor (the EHR the source data comes from) chosen from the managed vendor list.
    post('projects-create', '/projects', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('editor');
      await this.ensureProjectsTable();
      await this.ensureVendorsTable();
      await this.ensureSchemaVersionsTable();
      const { name, description, sourceSystem, vendorCode, schemaVersionId } = (req.body ?? {}) as {
        name?: string; description?: string; sourceSystem?: string; vendorCode?: string; schemaVersionId?: string;
      };
      const clean = (name ?? '').trim();
      const ss = (sourceSystem ?? '').trim();
      const vc = (vendorCode ?? '').trim();
      const pvid = (schemaVersionId ?? '').trim() || DEFAULT_SCHEMA_VERSION_ID;
      if (!clean) { res.status(400).json({ error: 'A project name is required.' }); return undefined; }
      if (clean.length > 80) { res.status(400).json({ error: 'Project name must be ≤80 characters.' }); return undefined; }
      if (!ss) { res.status(400).json({ error: 'A source system is required.' }); return undefined; }
      // The source system must exist.
      const known = await this.listSourceSystems();
      if (!known.some((n) => n.toLowerCase() === ss.toLowerCase())) {
        res.status(400).json({ error: `Unknown source system '${ss}'.` }); return undefined;
      }
      // If a vendor was chosen, it must exist.
      if (vc) {
        const v = await this.runQuery(`SELECT vendor_code FROM ${VENDORS_TABLE} WHERE vendor_code = ${q(vc)} LIMIT 1`).catch(() => []);
        if (v.length === 0) { res.status(400).json({ error: `Unknown vendor code '${vc}'.` }); return undefined; }
      }
      // The schema version must exist.
      const pvExists = await this.runQuery(`SELECT version_id FROM ${SCHEMA_VERSIONS_TABLE} WHERE version_id = ${q(pvid)} LIMIT 1`).catch(() => []);
      if (pvExists.length === 0) { res.status(400).json({ error: `Unknown schema version '${pvid}'.` }); return undefined; }
      // Reject duplicate project names case-insensitively.
      const existing = await this.runQuery(`SELECT name FROM ${PROJECTS_TABLE} WHERE lower(name) = ${q(clean.toLowerCase())} LIMIT 1`);
      if (existing.length) { res.status(409).json({ error: `Project '${clean}' already exists.` }); return undefined; }
      const projectId = crypto.randomUUID();
      const resp = await this.execStatement(
        `INSERT INTO ${PROJECTS_TABLE} (project_id, name, description, source_system, vendor_code, schema_version_id, created_by, created_at, archived)
         VALUES (:project_id, :name, :description, :source_system, :vendor_code, ${q(pvid)}, ${q(this.currentUser())}, CURRENT_TIMESTAMP(), false)`,
        [
          { name: 'project_id', value: projectId },
          { name: 'name', value: clean },
          { name: 'description', value: (description ?? '').trim() || null },
          { name: 'source_system', value: ss },
          { name: 'vendor_code', value: vc || null },
        ],
      );
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Create failed');
      this.invalidateCache('projects:'); // project list changed
      return { ok: true, projectId, name: clean, sourceSystem: ss, vendorCode: vc || null };
    });

    // 13f-3b. Projects: edit name / description / vendor (editor+). Source system is
    // fixed after creation (it scopes existing mappings), so it is not editable here.
    put('projects-update', '/projects', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('editor');
      await this.ensureProjectsTable();
      await this.ensureVendorsTable();
      await this.ensureSchemaVersionsTable();
      const { projectId, name, description, vendorCode, schemaVersionId } = (req.body ?? {}) as {
        projectId?: string; name?: string; description?: string; vendorCode?: string | null; schemaVersionId?: string;
      };
      const pid = (projectId ?? '').trim();
      if (!pid) { res.status(400).json({ error: 'projectId is required' }); return undefined; }
      const sets: string[] = [];
      const params: { name: string; value: string | null }[] = [];
      if (schemaVersionId !== undefined) {
        const pvid = (schemaVersionId ?? '').trim() || DEFAULT_SCHEMA_VERSION_ID;
        const pvExists = await this.runQuery(`SELECT version_id FROM ${SCHEMA_VERSIONS_TABLE} WHERE version_id = ${q(pvid)} LIMIT 1`).catch(() => []);
        if (pvExists.length === 0) { res.status(400).json({ error: `Unknown schema version '${pvid}'.` }); return undefined; }
        sets.push(`schema_version_id = ${q(pvid)}`);
      }
      if (name !== undefined) {
        const clean = (name ?? '').trim();
        if (!clean) { res.status(400).json({ error: 'Project name cannot be empty.' }); return undefined; }
        if (clean.length > 80) { res.status(400).json({ error: 'Project name must be ≤80 characters.' }); return undefined; }
        const dup = await this.runQuery(`SELECT project_id FROM ${PROJECTS_TABLE} WHERE lower(name) = ${q(clean.toLowerCase())} AND project_id <> ${q(pid)} LIMIT 1`);
        if (dup.length) { res.status(409).json({ error: `Another project named '${clean}' already exists.` }); return undefined; }
        sets.push('name = :name'); params.push({ name: 'name', value: clean });
      }
      if (description !== undefined) { sets.push('description = :description'); params.push({ name: 'description', value: (description ?? '').trim() || null }); }
      if (vendorCode !== undefined) {
        const vc = (vendorCode ?? '').trim();
        if (vc) {
          const v = await this.runQuery(`SELECT vendor_code FROM ${VENDORS_TABLE} WHERE vendor_code = ${q(vc)} LIMIT 1`).catch(() => []);
          if (v.length === 0) { res.status(400).json({ error: `Unknown vendor code '${vc}'.` }); return undefined; }
        }
        sets.push('vendor_code = :vendor_code'); params.push({ name: 'vendor_code', value: vc || null });
      }
      if (sets.length === 0) { res.status(400).json({ error: 'Nothing to update.' }); return undefined; }
      const resp = await this.execStatement(`UPDATE ${PROJECTS_TABLE} SET ${sets.join(', ')} WHERE project_id = ${q(pid)}`, params);
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Update failed');
      this.invalidateCache('projects:'); // project list changed
      return { ok: true };
    });

    // 13f-4. Projects: delete (admin only; blocked when it holds runs or is a default).
    del('projects-delete', '/projects', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('admin');
      await this.ensureProjectsTable();
      await this.ensureHistoryColumns();
      const projectId = (qstr(req.query.projectId) || (req.body as { projectId?: string })?.projectId || '').trim();
      if (!projectId) { res.status(400).json({ error: 'projectId is required' }); return undefined; }
      if (projectId.startsWith('default::')) {
        res.status(409).json({ error: 'A default project cannot be deleted — it is the fallback home for its source system.' }); return undefined;
      }
      // Reassign the project's runs/examples to their source system's default project
      // (clear project_id → the coalesce fallback picks default::<sourcesystem>), so
      // deleting a project never orphans or loses mappings.
      await this.execStatement(`UPDATE ${HISTORY_TABLE} SET project_id = NULL WHERE project_id = ${q(projectId)}`).catch(() => undefined);
      await this.execStatement(`UPDATE ${EXAMPLES_TABLE} SET project_id = NULL WHERE project_id = ${q(projectId)}`).catch(() => undefined);
      const resp = await this.execStatement(`DELETE FROM ${PROJECTS_TABLE} WHERE project_id = ${q(projectId)}`);
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Delete failed');
      this.invalidateCache('projects:'); // project list changed
      return { ok: true };
    });

    // 13f-5. Vendors: list (any role — drives the project-create vendor dropdown).
    get('vendors', '/vendors', async () => {
      this.assertCatalog();
      await this.ensureVendorsTable();
      const rows = await this.runQuery(
        `SELECT vendor_code, name, description, created_by, created_at FROM ${VENDORS_TABLE} ORDER BY name`,
      );
      return { vendors: rows };
    });

    // 13f-6. Vendors: create (admin only). vendor_code is the unique key.
    post('vendors-create', '/vendors', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('admin');
      await this.ensureVendorsTable();
      const { name, code, description } = (req.body ?? {}) as { name?: string; code?: string; description?: string };
      const cleanName = (name ?? '').trim();
      const cleanCode = (code ?? '').trim();
      if (!cleanName) { res.status(400).json({ error: 'A vendor name is required.' }); return undefined; }
      if (!cleanCode) { res.status(400).json({ error: 'A vendor code is required.' }); return undefined; }
      if (cleanCode.length > 40 || !/^[\w.&/-]+$/.test(cleanCode)) {
        res.status(400).json({ error: 'Vendor code must be ≤40 chars (letters, numbers, . & / - _; no spaces).' });
        return undefined;
      }
      if (cleanName.length > 80) { res.status(400).json({ error: 'Vendor name must be ≤80 characters.' }); return undefined; }
      // Reject duplicate codes case-insensitively.
      const existing = await this.runQuery(`SELECT vendor_code FROM ${VENDORS_TABLE} WHERE lower(vendor_code) = ${q(cleanCode.toLowerCase())} LIMIT 1`);
      if (existing.length) { res.status(409).json({ error: `Vendor code '${cleanCode}' already exists.` }); return undefined; }
      const resp = await this.execStatement(
        `INSERT INTO ${VENDORS_TABLE} (vendor_code, name, description, created_by, created_at)
         VALUES (:vendor_code, :name, :description, ${q(this.currentUser())}, CURRENT_TIMESTAMP())`,
        [
          { name: 'vendor_code', value: cleanCode },
          { name: 'name', value: cleanName },
          { name: 'description', value: (description ?? '').trim() || null },
        ],
      );
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Create failed');
      return { ok: true, vendorCode: cleanCode, name: cleanName };
    });

    // 13f-6b. Vendors: edit name and/or description (admin only). The code is the key
    // projects reference, so it stays fixed.
    put('vendors-update', '/vendors', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('admin');
      await this.ensureVendorsTable();
      const { code, name, description } = (req.body ?? {}) as { code?: string; name?: string; description?: string | null };
      const cleanCode = (code ?? '').trim();
      const cleanName = (name ?? '').trim();
      if (!cleanCode) { res.status(400).json({ error: 'code is required' }); return undefined; }
      if (!cleanName) { res.status(400).json({ error: 'A vendor name is required.' }); return undefined; }
      if (cleanName.length > 80) { res.status(400).json({ error: 'Vendor name must be ≤80 characters.' }); return undefined; }
      const resp = await this.execStatement(
        `UPDATE ${VENDORS_TABLE} SET name = :name, description = :description WHERE vendor_code = :vendor_code`,
        [
          { name: 'vendor_code', value: cleanCode },
          { name: 'name', value: cleanName },
          { name: 'description', value: (description ?? '').trim() || null },
        ],
      );
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Update failed');
      this.invalidateCache('projects:'); // project list shows vendor names
      return { ok: true };
    });

    // 13f-7. Vendors: delete (admin only; blocked while a project references it).
    del('vendors-delete', '/vendors', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('admin');
      await this.ensureVendorsTable();
      await this.ensureProjectsTable();
      const code = (qstr(req.query.code) || (req.body as { code?: string })?.code || '').trim();
      if (!code) { res.status(400).json({ error: 'code is required' }); return undefined; }
      const inUse = await this.runQuery(`SELECT COUNT(*) AS n FROM ${PROJECTS_TABLE} WHERE vendor_code = ${q(code)}`).catch(() => [{ n: '0' }]);
      if (intOr(inUse[0]?.n ?? null, 0) > 0) {
        res.status(409).json({ error: `Cannot delete vendor '${code}': ${intOr(inUse[0]?.n ?? null, 0)} project(s) still reference it. Reassign them first.` });
        return undefined;
      }
      const resp = await this.execStatement(`DELETE FROM ${VENDORS_TABLE} WHERE vendor_code = ${q(code)}`);
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Delete failed');
      return { ok: true };
    });

    // 13h-b. Per-source-system mapping instructions. GET is readable by any role (viewers
    // see the guidance in effect); PUT is editor-gated. The text is injected into the
    // identify + generate prompts to steer mapping behavior for that source system.
    get('source-system-instructions', '/source-system-instructions', async (req, res) => {
      this.assertCatalog();
      const sourceSystem = (qstr(req.query.sourceSystem) || DEFAULT_SOURCE_SYSTEM).trim();
      if (!sourceSystem) { res.status(400).json({ error: 'sourceSystem is required' }); return undefined; }
      await this.ensureSourceSystemInstructionsTable();
      const rows = await this.runQuery(
        `SELECT instructions, updated_by, updated_at FROM ${SOURCE_SYSTEM_INSTRUCTIONS_TABLE} WHERE domain = ${q(sourceSystem)} LIMIT 1`,
      );
      return {
        sourceSystem,
        instructions: rows[0]?.instructions ?? '',
        updatedBy: rows[0]?.updated_by ?? null,
        updatedAt: rows[0]?.updated_at ?? null,
      };
    });

    put('source-system-instructions', '/source-system-instructions', async (req, res) => {
      await this.requireRole('editor');
      const { sourceSystem, instructions } = req.body as { sourceSystem?: string; instructions?: string };
      const ss = (sourceSystem ?? '').trim();
      if (!ss) { res.status(400).json({ error: 'sourceSystem is required' }); return undefined; }
      const text = (instructions ?? '').trim();
      // Keep prompt overhead bounded — the text is injected verbatim into every
      // identify + generate call for this source system.
      if (text.length > 4000) { res.status(400).json({ error: 'Instructions exceed the 4000-character limit.' }); return undefined; }
      await this.ensureSourceSystemInstructionsTable();
      const user = this.currentUser();
      // Parameterized MERGE — instructions is free text that can contain quotes.
      const resp = await this.execStatement(
        `MERGE INTO ${SOURCE_SYSTEM_INSTRUCTIONS_TABLE} t
         USING (SELECT ${q(ss)} AS domain) s
         ON t.domain = s.domain
         WHEN MATCHED THEN UPDATE SET instructions = :instructions, updated_by = ${q(user)}, updated_at = CURRENT_TIMESTAMP()
         WHEN NOT MATCHED THEN INSERT (domain, instructions, updated_by, updated_at)
           VALUES (${q(ss)}, :instructions, ${q(user)}, CURRENT_TIMESTAMP())`,
        [{ name: 'instructions', value: text }],
      );
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Save failed');
      this.invalidateCache('instructions:'); // injected mapping instructions changed
      return { ok: true, sourceSystem: ss };
    });

    // 13i. Retrieval index status — is semantic Vector Search configured, how many
    // rows are in the corpus, and is the index ready. Read-only and non-sensitive,
    // so it's available to all roles (the Mapping Examples page surfaces it too);
    // the rebuild action below stays admin-only.
    get('retrieval-status', '/retrieval-status', async () => {
      let corpusRows: number | null = null;
      let lastRebuiltAt: string | null = null;
      let indexReady: boolean | null = null;
      if (VS_INDEX) {
        try {
          const rows = await this.runQuery(`SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM ${CORPUS_TABLE}`);
          corpusRows = intOr(rows[0]?.n ?? null, 0);
          lastRebuiltAt = rows[0]?.last ?? null;
        } catch { corpusRows = null; }
        // Index readiness: probe the index with a tiny vector_search() query over the
        // warehouse — the same `sql` scope + path retrieval uses. A successful query
        // means the index is serving/ready; an error means it isn't queryable yet
        // (e.g. re-embedding after a rebuild). We deliberately avoid the Vector Search
        // REST API here: the app service principal isn't granted on the index, so that
        // call silently fails and always returned null (Index Status "Unknown").
        try {
          await this.runQuery(
            `SELECT 1 FROM vector_search(index => ${q(VS_INDEX)}, query_text => 'ping', num_results => 1)`,
          );
          indexReady = true;
        } catch {
          indexReady = false;
        }
      }
      return {
        configured: VS_INDEX.trim().length > 0,
        endpoint: VS_ENDPOINT || null,
        index: VS_INDEX || null,
        corpusTable: CORPUS_TABLE,
        corpusRows,
        lastRebuiltAt,
        indexReady,
      };
    });

    // 13j. Rebuild the retrieval corpus from base tables, then trigger the index to
    // re-embed. Available to editors (they curate the examples that feed the corpus)
    // and admins — surfaced both on the Admin page and the Mapping Examples page.
    post('retrieval-rebuild', '/retrieval-rebuild', async (_req, res) => {
      await this.requireRole('editor');
      if (!VS_INDEX) { res.status(400).json({ error: 'Vector Search is not configured (AIMAPPER_VS_INDEX unset).' }); return undefined; }
      const n = await this.rebuildCorpus();
      return { ok: true, corpusRows: n };
    });

    // 13j-2. Prompt Sizing profile — the active profile + its resolved limits.
    // Readable by editors (they run generation); only admins can change it.
    get('prompt-profile', '/prompt-profile', async () => {
      await this.requireRole('editor');
      const profile = await this.loadPromptProfile();
      return { profile, options: Object.keys(PROMPT_PROFILES) as PromptProfile[], limits: resolvePromptProfile(profile) };
    });
    post('prompt-profile', '/prompt-profile', async (req, res) => {
      await this.requireRole('admin');
      const email = this.currentUser();
      const profile = String((req.body as { profile?: string })?.profile ?? '').toLowerCase();
      if (!(profile in PROMPT_PROFILES)) {
        res.status(400).json({ error: `profile must be one of: ${Object.keys(PROMPT_PROFILES).join(', ')}` });
        return undefined;
      }
      await this.ensureSettingsTable();
      await this.execStatement(
        `MERGE INTO ${SETTINGS_TABLE} t
         USING (SELECT :key AS key, :value AS value, :updated_by AS updated_by) s
         ON t.key = s.key
         WHEN MATCHED THEN UPDATE SET value = s.value, updated_by = s.updated_by, updated_at = CURRENT_TIMESTAMP()
         WHEN NOT MATCHED THEN INSERT (key, value, updated_by, updated_at)
              VALUES (s.key, s.value, s.updated_by, CURRENT_TIMESTAMP())`,
        [
          { name: 'key', value: 'prompt_profile' },
          { name: 'value', value: profile },
          { name: 'updated_by', value: email || null },
        ],
      );
      this.invalidateCache('settings:prompt_profile');
      return { ok: true, profile: profile as PromptProfile, limits: resolvePromptProfile(profile) };
    });

    // 13j-3. Task-size model auto-selection (opt-in). Editors read; admins change.
    get('model-selection', '/model-selection', async () => {
      await this.requireRole('editor');
      return { autoSelect: await this.loadAutoModelSelect(), tiers: await this.loadModelTiers() };
    });
    post('model-selection', '/model-selection', async (req) => {
      await this.requireRole('admin');
      const email = this.currentUser();
      const body = (req.body ?? {}) as { autoSelect?: boolean; tiers?: { strong?: string; standard?: string; light?: string } };
      const tiers = { strong: String(body.tiers?.strong ?? ''), standard: String(body.tiers?.standard ?? ''), light: String(body.tiers?.light ?? '') };
      await this.ensureSettingsTable();
      const upsert = (key: string, value: string) =>
        this.execStatement(
          `MERGE INTO ${SETTINGS_TABLE} t
           USING (SELECT :key AS key, :value AS value, :updated_by AS updated_by) s
           ON t.key = s.key
           WHEN MATCHED THEN UPDATE SET value = s.value, updated_by = s.updated_by, updated_at = CURRENT_TIMESTAMP()
           WHEN NOT MATCHED THEN INSERT (key, value, updated_by, updated_at)
                VALUES (s.key, s.value, s.updated_by, CURRENT_TIMESTAMP())`,
          [
            { name: 'key', value: key },
            { name: 'value', value },
            { name: 'updated_by', value: email || null },
          ],
        );
      await upsert('auto_model_select', body.autoSelect ? 'on' : 'off');
      await upsert('model_tiers', JSON.stringify(tiers));
      this.invalidateCache('settings:auto_model_select');
      this.invalidateCache('settings:model_tiers');
      return { ok: true, autoSelect: body.autoSelect === true, tiers };
    });

    // 13k. Token usage stats (admin): total, by-user, and recent per-task rows.
    get('usage-stats', '/usage-stats', async () => {
      await this.requireRole('admin');
      await this.ensureHistoryColumns();
      const num0 = (v: string | null) => intOr(v, 0);
      const [totals, byUser, recent] = await Promise.all([
        this.runQuery(
          `SELECT COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c,
                  COALESCE(SUM(total_tokens),0) AS t, COUNT(*) AS runs
           FROM ${HISTORY_TABLE}`,
        ).catch(() => [] as Record<string, string | null>[]),
        this.runQuery(
          `SELECT COALESCE(created_by,'unknown') AS user_email,
                  COALESCE(SUM(total_tokens),0) AS total_tokens,
                  COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
                  COALESCE(SUM(completion_tokens),0) AS completion_tokens,
                  COUNT(*) AS runs
           FROM ${HISTORY_TABLE} GROUP BY created_by ORDER BY total_tokens DESC LIMIT 100`,
        ).catch(() => [] as Record<string, string | null>[]),
        this.runQuery(
          `SELECT item_id, created_at, created_by, target_table, coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)}) AS source_system,
                  endpoint_name, total_tokens, prompt_tokens, completion_tokens
           FROM ${HISTORY_TABLE} WHERE total_tokens IS NOT NULL AND total_tokens > 0
           ORDER BY created_at DESC LIMIT 50`,
        ).catch(() => [] as Record<string, string | null>[]),
      ]);
      const tot = totals[0] ?? {};
      return {
        total: {
          promptTokens: num0(tot.p ?? null),
          completionTokens: num0(tot.c ?? null),
          totalTokens: num0(tot.t ?? null),
          runs: num0(tot.runs ?? null),
        },
        byUser: byUser.map((r) => ({
          userEmail: r.user_email ?? 'unknown',
          totalTokens: num0(r.total_tokens),
          promptTokens: num0(r.prompt_tokens),
          completionTokens: num0(r.completion_tokens),
          runs: num0(r.runs),
        })),
        recent: recent.map((r) => ({
          itemId: r.item_id ?? '',
          createdAt: r.created_at ?? '',
          createdBy: r.created_by ?? 'unknown',
          targetTable: r.target_table ?? '',
          sourceSystem: r.source_system ?? DEFAULT_SOURCE_SYSTEM,
          endpointName: r.endpoint_name ?? '',
          totalTokens: num0(r.total_tokens),
          promptTokens: num0(r.prompt_tokens),
          completionTokens: num0(r.completion_tokens),
        })),
      };
    });

    // 14. Examples list. Optional source-system filter.
    get('examples', '/examples', async (req) => {
      this.assertCatalog();
      await this.ensureExamplesColumns();
      const sourceSystem = qstr(req.query.sourceSystem);
      const where = sourceSystem ? `WHERE coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)}) = ${q(sourceSystem)}` : '';
      const rows = await this.runQuery(
        `SELECT example_id, target_table, source_signature, generated_sql, notes, approved, created_by, created_at,
                coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)}) AS source_system,
                coalesce(project_id, concat('default::', lower(coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)})))) AS project_id
         FROM ${EXAMPLES_TABLE} ${where} ORDER BY created_at DESC LIMIT 500`,
      );
      return { examples: rows };
    });

    // 15. Save an example (editor+ — references curate the shared prompt corpus).
    post('examples-save', '/examples', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('editor');
      const { targetTable, sourceSignature, sourceColumns, generatedSql, notes, createdBy, approved, sourceSystem, projectId } = req.body as {
        targetTable: string; sourceSignature?: string; sourceColumns?: string; generatedSql: string;
        notes?: string; createdBy?: string; approved?: boolean; sourceSystem?: string; projectId?: string;
      };
      if (!targetTable || !generatedSql?.trim()) {
        res.status(400).json({ error: 'targetTable and generatedSql are required' }); return undefined;
      }
      await this.ensureExamplesColumns();
      const user = createdBy ?? this.currentUser();
      const exampleId = crypto.randomUUID();
      const ss = (sourceSystem ?? '').trim() || DEFAULT_SOURCE_SYSTEM;
      const pid = (projectId ?? '').trim() || defaultProjectId(ss);
      const insert = `INSERT INTO ${EXAMPLES_TABLE}
(example_id, target_table, source_signature, source_columns, generated_sql, notes, approved, created_by, created_at, domain, project_id)
VALUES (:example_id, :target_table, :source_signature, :source_columns, :generated_sql, :notes, ${approved === false ? 'false' : 'true'}, :created_by, CURRENT_TIMESTAMP(), :domain, :project_id)`;
      const resp = await this.execStatement(insert, [
        { name: 'example_id', value: exampleId },
        { name: 'target_table', value: targetTable },
        { name: 'source_signature', value: sourceSignature ?? null },
        { name: 'source_columns', value: sourceColumns ?? null },
        { name: 'generated_sql', value: generatedSql.trim() },
        { name: 'notes', value: notes ?? null },
        { name: 'created_by', value: user },
        { name: 'domain', value: ss },
        { name: 'project_id', value: pid },
      ]);
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Insert failed');
      // Mirror into the retrieval corpus (approved examples only).
      if (approved !== false) {
        await this.upsertCorpusRow({
          id: `example:${exampleId}`, kind: 'example', domain: ss, projectId: pid, targetTable,
          sourceSignature: sourceSignature ?? null, sourceColumns: sourceColumns ?? null, generatedSql: generatedSql.trim(),
        });
      }
      return { ok: true, exampleId };
    });

    // 15b. Update an existing example (editor+).
    put('examples-update', '/examples', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('editor');
      const { exampleId, targetTable, sourceSignature, sourceColumns, generatedSql, notes, approved, sourceSystem } = req.body as {
        exampleId: string; targetTable: string; sourceSignature?: string; sourceColumns?: string;
        generatedSql: string; notes?: string; approved?: boolean; sourceSystem?: string;
      };
      if (!exampleId || !targetTable || !generatedSql?.trim()) {
        res.status(400).json({ error: 'exampleId, targetTable and generatedSql are required' }); return undefined;
      }
      await this.ensureExamplesColumns();
      const updateParams = [
        { name: 'target_table', value: targetTable },
        { name: 'source_signature', value: sourceSignature ?? null },
        { name: 'source_columns', value: sourceColumns ?? null },
        { name: 'generated_sql', value: generatedSql.trim() },
        { name: 'notes', value: notes ?? null },
        { name: 'example_id', value: exampleId },
      ];
      if (sourceSystem !== undefined) updateParams.push({ name: 'domain', value: (sourceSystem ?? '').trim() || DEFAULT_SOURCE_SYSTEM });
      const update = `UPDATE ${EXAMPLES_TABLE} SET
        target_table = :target_table,
        source_signature = :source_signature,
        source_columns = :source_columns,
        generated_sql = :generated_sql,
        notes = :notes,
        approved = ${approved === false ? 'false' : 'true'}${sourceSystem !== undefined ? ',\n        domain = :domain' : ''}
        WHERE example_id = :example_id`;
      const resp = await this.execStatement(update, updateParams);
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Update failed');
      // Keep the corpus in step: approved → upsert; unapproved → remove. Read back the
      // row's effective source system + project so the corpus row carries its scope.
      if (approved === false) {
        await this.deleteCorpusRow(`example:${exampleId}`);
      } else {
        const eff = await this.runQuery(
          `SELECT coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)}) AS source_system,
                  coalesce(project_id, concat('default::', lower(coalesce(domain, ${q(DEFAULT_SOURCE_SYSTEM)})))) AS project_id
           FROM ${EXAMPLES_TABLE} WHERE example_id = ${q(exampleId)} LIMIT 1`,
        ).catch(() => []);
        const ss = eff[0]?.source_system ?? DEFAULT_SOURCE_SYSTEM;
        await this.upsertCorpusRow({
          id: `example:${exampleId}`, kind: 'example', domain: ss, projectId: eff[0]?.project_id ?? defaultProjectId(ss), targetTable,
          sourceSignature: sourceSignature ?? null, sourceColumns: sourceColumns ?? null, generatedSql: generatedSql.trim(),
        });
      }
      return { ok: true };
    });

    // 16. Delete an example (editor+).
    del('examples-delete', '/examples', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('editor');
      const exampleId = qstr(req.query.exampleId) || (req.body as { exampleId?: string })?.exampleId || '';
      if (!exampleId) { res.status(400).json({ error: 'exampleId is required' }); return undefined; }
      const resp = await this.execStatement(`DELETE FROM ${EXAMPLES_TABLE} WHERE example_id = ${q(exampleId)}`);
      if (resp.status?.state !== 'SUCCEEDED') throw new Error(resp.status?.error?.message ?? 'Delete failed');
      await this.deleteCorpusRow(`example:${exampleId}`);
      return { ok: true };
    });

    // ---- Reference documents (Vector Search grounding) ---------------------

    // 17. Grounding status — index configured?, passage counts, re-index progress.
    get('reference-docs-status', '/reference-docs/status', async () => {
      const configured = DOCS_INDEX.trim().length > 0;
      const stats = configured ? await this.referenceIndexStats() : null;
      return {
        configured,
        index: configured
          ? { name: DOCS_INDEX, chunks: stats?.chunks ?? 0, files: stats?.files ?? 0, lastIndexedAt: stats?.lastIndexedAt ?? null, ...this.refIndex }
          : null,
        volume: DOCS_VOLUME,
      };
    });

    // 18. List reference PDFs for a domain (files only, sorted by name).
    get('reference-docs', '/reference-docs', async (req) => {
      this.assertCatalog();
      const ctx = this.ctx();
      const dir = this.docsDir(qstr(req.query.sourceSystem));
      const files: { name: string; path: string; size: number | null; modified: number | null }[] = [];
      try {
        for await (const e of ctx.client.files.listDirectoryContents({ directory_path: dir })) {
          if (e.is_directory) continue;
          const path = e.path ?? '';
          files.push({
            name: e.name ?? path.split('/').pop() ?? path,
            path,
            size: e.file_size ?? null,
            modified: e.last_modified ?? null,
          });
        }
      } catch (e) {
        const msg = errMsg(e);
        // A domain subfolder that has no uploads yet doesn't exist — that's not an
        // error, just an empty list.
        if (/not.?found|does not exist|no such/i.test(msg)) return { files: [] };
        // Volume may not exist yet, or the user lacks READ VOLUME / the `files`
        // scope — surface as empty with a hint rather than a hard error so the
        // page still renders. Translate a missing-scope error into re-auth guidance.
        const scope = missingScope(msg);
        const error = scope
          ? `Your sign-in needs the '${scope}' permission, which was added since you last authorized this app. ` +
            `Sign out and back in (or open the app in a new session) to re-authorize, then reload.`
          : msg;
        return { files: [], error, needsReauth: !!scope };
      }
      files.sort((a, b) => a.name.localeCompare(b.name));
      // Chunk counts per file when Vector Search grounding is configured.
      const perFile = DOCS_INDEX.trim() ? (await this.referenceIndexStats()).perFile : null;
      return { files: perFile ? files.map((f) => ({ ...f, chunks: perFile[f.path] ?? 0 })) : files };
    });

    // 18b. Download a single reference file from a domain's folder. Streams the
    // volume file body straight back to the browser as an attachment.
    get('reference-docs-download', '/reference-docs/download', async (req, res) => {
      this.assertCatalog();
      const name = qstr(req.query.name).trim();
      // Only a plain filename — no path traversal out of the domain folder.
      if (!name || name.includes('/') || name.includes('\\')) {
        res.status(400).json({ error: 'a valid file name is required' }); return undefined;
      }
      const ctx = this.ctx();
      const filePath = `${this.docsDir(qstr(req.query.sourceSystem))}/${name}`;
      const dl = await ctx.client.files.download({ file_path: filePath });
      res.setHeader('Content-Type', dl['content-type'] || 'application/octet-stream');
      if (dl['content-length'] != null) res.setHeader('Content-Length', String(dl['content-length']));
      // HTTP header values must be ISO-8859-1, so the plain `filename` fallback must be
      // ASCII only — replace control/non-ASCII chars (and quotes/backslashes) with '_',
      // or Node throws "Invalid character in header content". The RFC 5987 `filename*`
      // carries the real UTF-8 name (percent-encoded, ASCII-safe) and modern browsers
      // prefer it, so the true filename is still preserved.
      const asciiName = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
      const stream = dl.contents;
      if (!stream) { res.end(); return undefined; }
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
      }
      res.end();
      return undefined;
    });

    // 19. Upload a reference file to the volume (editor+). Streams the raw body.
    post('reference-docs-upload', '/reference-docs/upload', async (req, res) => {
      this.assertCatalog();
      const name = qstr(req.query.name).trim();
      if (!name) { res.status(400).json({ error: 'name query param is required' }); return undefined; }
      // Only a plain filename — no path traversal into other directories.
      if (name.includes('/') || name.includes('\\') || name.startsWith('.') || name.startsWith('_')) {
        res.status(400).json({ error: 'Invalid file name (no path separators; must not start with . or _).' });
        return undefined;
      }
      // Authorize BEFORE reading the body, so a non-editor can't push the whole file
      // into memory before being rejected. The request stream stays paused until we
      // start iterating it below (no 'data' listener is attached during the await), so
      // the bytes are not lost while the role check runs — Node buffers them at the
      // socket. Reference docs are small (the UI caps them well under the assistant's
      // 100 MB limit), so buffering in memory once authorized is fine.
      await this.requireRole('editor');
      const chunks: Buffer[] = [];
      for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const ctx = this.ctx();
      const filePath = `${this.docsDir(qstr(req.query.sourceSystem))}/${name}`;
      // Do NOT use ctx.client.files.upload(): in @databricks/sdk-experimental its
      // FilesService._upload sends payload=undefined, so every upload lands as a
      // 0-byte file (verified). PUT the bytes to the Files API directly, reusing the
      // SDK client's OBO auth + host so it still runs on-behalf-of the user.
      const api = ctx.client.apiClient;
      const host = (await api.host).toString().replace(/\/$/, '');
      const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
      await api.config.authenticate(headers);
      const resp = await fetch(`${host}/api/2.0/fs/files${filePath}?overwrite=true`, {
        method: 'PUT',
        headers,
        body,
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`Upload failed (${resp.status}): ${detail || resp.statusText}`);
      }
      this.startReindex([filePath]); // parse + chunk in the background
      return { ok: true, name, indexing: DOCS_INDEX.trim().length > 0 };
    });

    // 20. Delete a reference file from a domain's folder (editor+).
    del('reference-docs-delete', '/reference-docs', async (req, res) => {
      this.assertCatalog();
      await this.requireRole('editor');
      const name = (qstr(req.query.name) || (req.body as { name?: string })?.name || '').trim();
      if (!name || name.includes('/') || name.includes('\\')) {
        res.status(400).json({ error: 'a valid file name is required' }); return undefined;
      }
      const ctx = this.ctx();
      const deletedPath = `${this.docsDir(qstr(req.query.sourceSystem))}/${name}`;
      await ctx.client.files.delete({ file_path: deletedPath });
      this.startReindex([deletedPath]); // drop its chunks in the background
      return { ok: true };
    });

    // 21. Re-index every reference document (editor+): reconciles the volume with the
    // chunk table in the background (new/changed files parsed, removed files dropped).
    post('reference-docs-sync', '/reference-docs/sync', async (_req, res) => {
      await this.requireRole('editor');
      if (!DOCS_INDEX.trim()) {
        res.status(400).json({ error: 'Reference grounding is not configured (AIMAPPER_DOCS_INDEX is not set).' });
        return undefined;
      }
      this.startReindex();
      return { ok: true, indexing: true };
    });

    // ── 23. Genie Agent (Ask Genie panel) ──────────────────────────────
    // Returns the space id so the client knows whether to show the panel.
    get('genie-config', '/genie-config', () => {
      return Promise.resolve({ enabled: GENIE_SPACE_ID.length > 0, spaceId: GENIE_SPACE_ID || null });
    });

    // Start a new Genie conversation or continue an existing one.
    post('genie-ask', '/genie-ask', async (req) => {
      if (!GENIE_SPACE_ID) { throw new Error('Genie Agent is not configured (AIMAPPER_GENIE_SPACE_ID is empty).'); }
      const { question, conversationId } = req.body as { question: string; conversationId?: string };
      if (!question?.trim()) { throw new Error('question is required'); }
      const ctx = this.ctx();
      if (conversationId) {
        // Continue existing conversation
        const r = await ctx.client.apiClient.request({
          path: `/api/2.0/genie/spaces/${GENIE_SPACE_ID}/conversations/${conversationId}/messages`,
          method: 'POST',
          headers: new Headers({ 'Content-Type': 'application/json' }),
          raw: false,
          payload: { content: question },
        }) as Record<string, unknown>;
        return { conversationId, messageId: r.message_id ?? (r.message as Record<string, unknown>)?.id };
      } else {
        // Start a new conversation
        const r = await ctx.client.apiClient.request({
          path: `/api/2.0/genie/spaces/${GENIE_SPACE_ID}/start-conversation`,
          method: 'POST',
          headers: new Headers({ 'Content-Type': 'application/json' }),
          raw: false,
          payload: { content: question },
        }) as Record<string, unknown>;
        return {
          conversationId: r.conversation_id,
          messageId: r.message_id ?? (r.message as Record<string, unknown>)?.id,
        };
      }
    });

    // Poll a Genie message for completion.
    get('genie-poll', '/genie-poll', async (req) => {
      if (!GENIE_SPACE_ID) { throw new Error('Genie Agent is not configured.'); }
      const conversationId = qstr(req.query.conversationId);
      const messageId = qstr(req.query.messageId);
      if (!conversationId || !messageId) { throw new Error('conversationId and messageId are required'); }
      const ctx = this.ctx();
      const r = await ctx.client.apiClient.request({
        path: `/api/2.0/genie/spaces/${GENIE_SPACE_ID}/conversations/${conversationId}/messages/${messageId}`,
        method: 'GET',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        raw: false,
      }) as Record<string, unknown>;
      const status = (r.status as string) ?? 'UNKNOWN';
      const attachments = (r.attachments ?? []) as Array<Record<string, unknown>>;
      // Extract the text answer
      let answer = '';
      let sql = '';
      let statementId = '';
      let attachmentId = '';
      const suggestedQuestions: string[] = [];
      for (const att of attachments) {
        if (att.text) {
          const t = att.text as Record<string, unknown>;
          if (t.purpose === 'TEXT_ATTACHMENT_PURPOSE_ANSWER') answer = (t.content as string) ?? '';
        }
        if (att.query) {
          const q_ = att.query as Record<string, unknown>;
          sql = (q_.query as string) ?? '';
          statementId = (q_.statement_id as string) ?? '';
          attachmentId = (att.attachment_id as string) ?? '';
        }
        if (att.suggested_questions) {
          const sq = att.suggested_questions as Record<string, unknown>;
          const qs = (sq.questions ?? []) as string[];
          suggestedQuestions.push(...qs);
        }
      }
      return { status, answer, sql, statementId, attachmentId, suggestedQuestions };
    });

    // Fetch Genie query result rows.
    get('genie-query-result', '/genie-query-result', async (req) => {
      if (!GENIE_SPACE_ID) { throw new Error('Genie Agent is not configured.'); }
      const conversationId = qstr(req.query.conversationId);
      const messageId = qstr(req.query.messageId);
      const attachmentId = qstr(req.query.attachmentId);
      if (!conversationId || !messageId || !attachmentId) { throw new Error('conversationId, messageId, and attachmentId are required'); }
      const ctx = this.ctx();
      const r = await ctx.client.apiClient.request({
        path: `/api/2.0/genie/spaces/${GENIE_SPACE_ID}/conversations/${conversationId}/messages/${messageId}/query-result/${attachmentId}`,
        method: 'GET',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        raw: false,
      }) as Record<string, unknown>;
      const sr = (r.statement_response ?? r) as Record<string, unknown>;
      const manifest = (sr.manifest ?? {}) as Record<string, unknown>;
      const schema = (manifest.schema ?? {}) as Record<string, unknown>; // reconstructed: line hidden between screenshots
      const cols = ((schema.columns ?? []) as Array<Record<string, unknown>>).map((c) => (c.name as string) ?? ''); // reconstructed: partially hidden
      const result = (sr.result ?? {}) as Record<string, unknown>;
      const rows = (result.data_array ?? []) as string[][];
      return { columns: cols, rows };
    });

  }
}

// --- helpers ----------------------------------------------------------------
function errMsg(e: unknown): string {
  return String(e instanceof Error ? e.message : e);
}

/** If an error is a missing-OBO-scope error, return the scope name; else null.
 * Matches messages like "Provided OAuth token does not have required scopes: files". */
function missingScope(msg: string): string | null {
  const m = msg.match(/does not have required scopes?:?\s*([a-z0-9._-]+)/i);
  return m ? m[1] : null;
}


/** Read a query-string param as a plain string (ignores arrays/objects). */
function qstr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** SQL-escape a string for inline INSERT (single quotes doubled). */
function q(v: string | null | undefined): string {
  if (v == null) return 'NULL';
  return `'${v.replace(/'/g, "''")}'`;
}

function num(v: number | null | undefined): string {
  return v == null || Number.isNaN(v) ? 'NULL' : String(v);
}

function intOr(v: string | null, fallback: number): number {
  const n = v == null || v === '' ? NaN : Number(v);
  return Number.isNaN(n) ? fallback : Math.trunc(n);
}

function rowToExample(r: Record<string, string | null>): MappingExample {
  return {
    example_id: r.example_id ?? '',
    target_table: r.target_table ?? '',
    source_signature: r.source_signature,
    source_columns: r.source_columns,
    generated_sql: r.generated_sql ?? '',
    notes: r.notes,
    approved: String(r.approved).toLowerCase() === 'true',
    created_by: r.created_by,
    created_at: r.created_at ?? '',
  };
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2);
}

export const aimapper = toPlugin(AiMapper);
