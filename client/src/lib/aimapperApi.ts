// Thin typed fetch wrappers around the aimapper plugin's routes (/api/aimapper/*).
// All reads (target schema, history, examples) and writes go through these so the
// catalog/schema stay env-driven (portable) on the server side.
import { trackActivity, type ActivityOptions } from './requestActivity';

// Typical durations (seconds) from the step log, shown as hints in the activity tray.
const LLM_EXPECTED_SEC: [number, number] = [15, 35];

export interface SourceColumn {
  name: string;
  typeName: string;
  typeText?: string;
  nullable: boolean;
  position: number;
  comment?: string;
}
export interface SourceTable {
  catalog: string;
  schema: string;
  table: string;
  columns: SourceColumn[];
}
export interface TargetColumn {
  target_table: string;
  target_column: string;
  ordinal_position: number;
  data_type: string;
  data_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: boolean;
  is_primary_key: boolean | null;
  description: string | null;
  transform_hint: string | null;
}
export interface TargetEntity {
  target_table: string;
  columns: TargetColumn[];
}
/** Target-driven: for one target column, the best source column across any table. */
export interface AttributeMapping {
  target_column: string;
  source_table: string | null;
  source_column: string | null;
  confidence: number;
  rationale: string;
}
export interface ColumnDiff {
  target_column: string;
  status: 'matched' | 'type_mismatch' | 'missing' | 'extra' | 'nullability_mismatch';
  expected?: string;
  actual?: string;
  detail?: string;
}
export interface ValidationReport {
  status: 'SUCCESS' | 'WARNINGS' | 'FAILED';
  compiles: boolean;
  errorMessage?: string;
  columns: ColumnDiff[];
}
export interface RunItem {
  itemId: string;
  sourceCatalog: string;
  sourceSchema: string;
  sourceTable: string;
  targetTable: string | null;
  matchMethod: string;
  matchConfidence: number | null;
  matchRationale: string | null;
  generatedSql: string | null;
  status: 'SUCCESS' | 'WARNINGS' | 'FAILED' | 'SKIPPED' | 'EDITED';
  validationReport: ValidationReport | null;
  errorMessage: string | null;
  durationMs: number | null;
  mappingsJson?: string | null;
  sourceSystem?: string | null;
  projectId?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
}
/** LLM token usage from a serving response. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
/** How attribute discovery bounded a large source-table selection (pre-filter + batching). */
export interface DiscoveryInfo {
  tablesSelected: number;
  tablesSearched: number;
  skippedTables: string[];
  batches: number;
  failedBatches: number;
}

/** Above this many selected source tables, discovery pre-filters to the most relevant ones (mirrors server MAX_DISCOVERY_TABLES). */
export const LARGE_SELECTION_WARN = 40;

export type Role = 'viewer' | 'editor' | 'admin';
export type ApprovalStatus = 'in_review' | 'approved' | 'rejected';
export type ApprovalAction = 'approve' | 'reject' | 'reopen';

export interface HistoryRow {
  run_id: string;
  item_id: string;
  created_at: string;
  created_by: string;
  source_schema: string;
  source_table: string;
  target_table: string | null;
  endpoint_name: string;
  match_method: string;
  source_catalog?: string;
  match_confidence: number | null;
  status: string;
  error_message: string | null;
  duration_ms: number | null;
  version: number | null;
  approval_status: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  source_system?: string | null;
  project_id?: string | null;
  project_name?: string | null;
}

/** A mapping project — the instance-level scope (one source system per project). */
export interface Project {
  project_id: string;
  name: string;
  description: string | null;
  source_system: string;
  vendor_code?: string | null;
  vendor_name?: string | null;
  schema_version_id?: string | null;
  schema_version_label?: string | null;
  created_by: string | null;
  created_at: string | null;
  archived?: string | boolean | null;
  run_count?: number | string | null;
  in_review?: number | string | null;
  approved?: number | string | null;
  mapped_targets?: number | string | null;
  last_activity?: string | null;
}

/** An EHR vendor a project's source data comes from (name + unique code + description). */
export interface Vendor {
  vendor_code: string;
  name: string;
  description: string | null;
  created_by?: string | null;
  created_at?: string | null;
}

/** A target-schema version — a labelled pointer to a target-schema table. */
export interface SchemaVersion {
  version_id: string;
  label: string;
  target_schema_table: string;
  description: string | null;
  is_default: string | boolean | null;
  created_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export type PrincipalType = 'user' | 'group';
/** One of the three account groups that carry each role's permissions. */
export interface RoleGroup {
  role: Role;
  name: string;
  /** null = the group doesn't exist (run setup/install.py). */
  id: string | null;
  members: number;
  /** Permissions the app has granted this group (0 = not applied yet). */
  grantsApplied: number;
  lastAppliedAt: string | null;
}
/** A member of a role group, at the highest role group they're in. */
export interface RoleMember {
  /** User email, or group / service principal display name. */
  principal: string;
  principalType: PrincipalType | 'service_principal';
  displayName: string;
  role: Role;
  /** Lower role groups the principal is also (redundantly) in. */
  alsoIn: Role[];
  updatedBy: string | null;
  updatedAt: string | null;
}
/** Outcome of granting/revoking one resource permission during a role change. */
export interface PermissionResult {
  resource: string;
  access: string;
  status: 'granted' | 'already' | 'revoked' | 'restored' | 'skipped' | 'failed';
  detail?: string;
}
/** Workspace users + groups available to the Admin role picker. */
export interface WorkspacePrincipals {
  users: { userName: string; displayName: string | null }[];
  /** workspaceLocal: workspace-only group — can't receive Unity Catalog grants. */
  groups: { displayName: string; workspaceLocal?: boolean }[];
  error: string | null;
}
export interface HistoryItemDetail {
  source_table: string;
  target_table: string | null;
  status: string;
  match_method: string | null;
  match_confidence: number | null;
  match_rationale: string | null;
  generated_sql: string | null;
  validation_report: string | null;
  error_message: string | null;
}
/** Full history row — used to reload a mapping into the Mapper and for lineage. */
export interface HistoryFullItem {
  run_id: string;
  item_id: string;
  created_at: string;
  created_by: string | null;
  source_catalog: string;
  source_schema: string;
  source_table: string;
  target_table: string | null;
  endpoint_name: string;
  match_rationale: string | null;
  generated_sql: string | null;
  status: string;
  validation_report: string | null;
  mappings_json: string | null;
  version: number | null;
  source_system?: string | null;
  project_id?: string | null;
  total_tokens?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
}
/** Aggregated token usage for the Admin Usage tab. */
export interface UsageStats {
  total: { promptTokens: number; completionTokens: number; totalTokens: number; runs: number };
  byUser: { userEmail: string; totalTokens: number; promptTokens: number; completionTokens: number; runs: number }[];
  recent: { itemId: string; createdAt: string; createdBy: string; targetTable: string; sourceSystem: string; endpointName: string; totalTokens: number; promptTokens: number; completionTokens: number }[];
}
export interface DashboardStats {
  totalTargets: number;
  mappedTargets: number;
  coveragePct: number;
  totalTargetColumns: number;
  mappedColumns: number;
  unmappedColumns: number;
  totalRuns: number;
  statusCounts: Record<string, number>;
  avgConfidence: number | null;
  topReferences: { target_table: string; count: number }[];
  perTarget: { target_table: string; columns: number; status: string; confidence: number | null }[];
  portfolio: { projects: number; sourceSystems: number; vendors: number };
  approval: { in_review: number; approved: number; rejected: number };
  bySourceSystem: { source_system: string; mappedTargets: number; avgConfidence: number | null }[];
  feedback: { up: number; down: number };
  tokens: { total: number; last7: number };
  tokenTrend: { date: string; prompt: number; completion: number }[];
}
export interface MappingExample {
  example_id: string;
  target_table: string;
  source_signature: string | null;
  generated_sql: string | null;
  notes: string | null;
  approved: string | boolean | null;
  created_by: string | null;
  created_at: string;
  source_system?: string | null;
  project_id?: string | null;
}
/** A reference PDF stored in the reference_docs volume. */
export interface ReferenceDoc {
  name: string;
  path: string;
  size: number | null;
  modified: number | null;
  /** Indexed chunks for this file (present when Vector Search grounding is configured). */
  chunks?: number;
}
/** One retrieved passage that grounded a mapping. */
export interface ReferenceSource {
  file: string;
  pages: string;
  heading: string | null;
  score: number;
  chars: number;
}
/** Vector Search reference index state (chunks of the reference PDFs). */
export interface ReferenceIndexStatus {
  name: string;
  chunks: number;
  files: number;
  lastIndexedAt: string | null;
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  filesParsed: number;
  filesRemoved: number;
}
export interface ReferenceDocsStatus {
  /** True when the Vector Search reference index is configured (AIMAPPER_DOCS_INDEX). */
  configured: boolean;
  volume: string;
  /** Vector Search chunk index (null when AIMAPPER_DOCS_INDEX is unset). */
  index?: ReferenceIndexStatus | null;
}

/** Per-user personalization, stored server-side (aimapper_user_prefs). */
export interface UserPrefs {
  defaultEndpoint: string | null;
  defaultCatalog: string | null;
  defaultSchema: string | null;
  defaultTarget: string | null;
  theme: string | null; // 'light' | 'dark' | 'system' | null
}

const BASE = '/api/aimapper';

async function getJson<T>(url: string, act?: ActivityOptions): Promise<T> {
  return trackActivity(act, async () => {
    const res = await fetch(url, { credentials: 'include' });
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok || body.error) throw new Error(body.error ?? `Request failed: ${res.status}`);
    return body;
  });
}

async function sendJson<T>(method: 'POST' | 'PUT' | 'DELETE', url: string, payload: unknown, act?: ActivityOptions): Promise<T> {
  return trackActivity(act, async () => {
    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok || body.error) throw new Error(body.error ?? `Request failed: ${res.status}`);
    return body;
  });
}

// Step-log correlation: the server returns a traceId from discovery/generation.
// We keep the latest one per target so validation and save-run can reference it,
// letting the server link all logged steps for a target to the saved run.
const traceByTarget = new Map<string, string>();
function rememberTrace(targetTable: string, traceId?: string): void {
  if (targetTable && traceId) traceByTarget.set(targetTable, traceId);
}
/** Latest step-log trace for a target in this browser session (undefined if none yet). */
export function currentTraceId(targetTable: string): string | undefined {
  return traceByTarget.get(targetTable);
}

export const api = {
  catalogs: () => getJson<{ catalogs: string[] }>(`${BASE}/catalogs`),
  schemas: (catalog: string) => getJson<{ schemas: string[] }>(`${BASE}/schemas?catalog=${encodeURIComponent(catalog)}`),
  tables: (catalog: string, schema: string) =>
    getJson<{ tables: string[] }>(`${BASE}/tables?catalog=${encodeURIComponent(catalog)}&schema=${encodeURIComponent(schema)}`),
  endpoints: () => getJson<{ endpoints: { name: string; task: string }[] }>(`${BASE}/endpoints`),
  targetEntities: (version?: string) => getJson<{ targets: TargetEntity[] }>(`${BASE}/target-entities${version ? `?version=${encodeURIComponent(version)}` : ''}`),
  schemaVersions: () => getJson<{ versions: SchemaVersion[] }>(`${BASE}/schema-versions`),
  createSchemaVersion: (payload: { label: string; catalog: string; schema: string; table: string; description?: string; isDefault?: boolean }) =>
    sendJson<{ ok: boolean; versionId?: string; message?: string; targetCount?: number }>('POST', `${BASE}/schema-versions`, payload),
  updateSchemaVersion: (payload: { versionId: string; label?: string; catalog?: string; schema?: string; table?: string; description?: string; isDefault?: boolean }) =>
    sendJson<{ ok: boolean; message?: string }>('PUT', `${BASE}/schema-versions`, payload),
  deleteSchemaVersion: (versionId: string) =>
    sendJson<{ ok: boolean }>('DELETE', `${BASE}/schema-versions?versionId=${encodeURIComponent(versionId)}`, {}),
  dashboardStats: (projectId?: string) =>
    getJson<DashboardStats>(`${BASE}/dashboard-stats${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  historyDetail: (itemId: string) => getJson<{ item: HistoryFullItem | null }>(`${BASE}/history-detail?itemId=${encodeURIComponent(itemId)}`),
  getConfig: () => getJson<{ targetSchemaTable: string; defaultTargetSchemaTable: string; isDefault: boolean }>(`${BASE}/config`),
  targetSchemaPreview: (table?: string) =>
    getJson<{ table: string; columns: string[]; rows: (string | null)[][]; error?: string }>(
      `${BASE}/target-schema-preview${table ? `?table=${encodeURIComponent(table)}` : ''}`,
    ),
  validateConfig: (catalog: string, schema: string, table: string) =>
    sendJson<{ ok: boolean; message: string; targetCount?: number }>('POST', `${BASE}/config/validate`, { catalog, schema, table }),
  saveConfig: (catalog: string, schema: string, table: string) =>
    sendJson<{ ok: boolean; message: string; targetSchemaTable?: string; targetCount?: number }>('POST', `${BASE}/config`, { catalog, schema, table }),
  sourceSchemas: (catalog: string, schema: string, tables: string[]) =>
    sendJson<{ sources: SourceTable[] }>('POST', `${BASE}/source-schemas`, { catalog, schema, tables }),
  matchAttributes: async (endpoint: string, target: TargetEntity, sources: SourceTable[], sourceSystem?: string, projectId?: string) => {
    const res = await sendJson<{ mappings: AttributeMapping[]; tokens?: TokenUsage; truncated?: boolean; discovery?: DiscoveryInfo; traceId?: string }>('POST', `${BASE}/match-attributes`, { endpoint, target, sources, sourceSystem, projectId },
      { kind: 'long', label: `Identifying mappings · ${target.target_table}`, expectedSec: LLM_EXPECTED_SEC });
    rememberTrace(target.target_table, res.traceId);
    return res;
  },
  sendFeedback: (payload: { targetTable: string; targetColumn: string; sourceTable: string | null; sourceColumn: string | null; vote: 'up' | 'down'; projectId?: string }) =>
    sendJson<{ ok: boolean }>('POST', `${BASE}/feedback`, payload),
  generateJoinSql: async (
    endpoint: string,
    target: TargetEntity,
    sources: SourceTable[],
    mappings: AttributeMapping[],
    sourceSystem?: string,
    // sampleData/sampleValues: [DATA-SAMPLING] per-run toggle + sample size (example values per column).
    opts?: { projectId?: string; crossProject?: boolean; userInstructions?: string; priorSql?: string; sampleData?: boolean; sampleValues?: number },
  ) => {
    const res = await sendJson<{ sql: string; readOnly: boolean; examplesUsed: number; examplesTruncated?: number; referenceUsed?: boolean; referenceSources?: ReferenceSource[]; promptTrimmed?: boolean; retrievalMethod?: 'vector_search' | 'lexical'; crossProject?: boolean; tokens?: TokenUsage; outputTruncated?: boolean; message?: string; selectedEndpoint?: string; traceId?: string }>('POST', `${BASE}/generate-join-sql`, {
      endpoint,
      target,
      sources,
      mappings,
      sourceSystem,
      projectId: opts?.projectId,
      crossProject: opts?.crossProject,
      userInstructions: opts?.userInstructions,
      priorSql: opts?.priorSql,
      sampleData: opts?.sampleData, // [DATA-SAMPLING]
      sampleValues: opts?.sampleValues, // [DATA-SAMPLING]
      traceId: traceByTarget.get(target.target_table),
    }, {
      kind: 'long',
      label: `${opts?.priorSql ? 'Regenerating SQL' : 'Generating SQL'} · ${target.target_table}`,
      expectedSec: LLM_EXPECTED_SEC,
    });
    rememberTrace(target.target_table, res.traceId);
    return res;
  },
  validateSql: (sql: string, target: TargetEntity) =>
    sendJson<{ report: ValidationReport }>('POST', `${BASE}/validate-sql`, { sql, target, traceId: traceByTarget.get(target.target_table) }),
  previewSql: (sql: string) =>
    sendJson<{ columns?: string[]; rows?: (string | null)[][]; error?: string }>('POST', `${BASE}/preview-sql`, { sql }),
  saveRun: (runId: string, endpoint: string, items: RunItem[], createdBy?: string) => {
    // Send the step-log trace for each saved target so the server can link
    // discovery/retrieval/generation/validation steps to this run.
    const traceIds = [...new Set(items.map((it) => (it.targetTable ? traceByTarget.get(it.targetTable) : undefined)).filter((t): t is string => !!t))];
    return sendJson<{ ok: boolean; runId: string; inserted: number }>('POST', `${BASE}/save-run`, { runId, endpoint, items, createdBy, traceIds });
  },
  // — Genie Agent (Ask Genie panel) ————————————————————————
  genieConfig: () => getJson<{ enabled: boolean; spaceId: string | null }>(`${BASE}/genie-config`),
  genieAsk: (question: string, conversationId?: string) =>
    sendJson<{ conversationId: string; messageId: string }>('POST', `${BASE}/genie-ask`, { question, conversationId }),
  geniePoll: (conversationId: string, messageId: string) =>
    getJson<{ status: string; answer: string; sql: string; statementId: string; attachmentId: string; suggestedQuestions: string[] }>(
      `${BASE}/genie-poll?conversationId=${encodeURIComponent(conversationId)}&messageId=${encodeURIComponent(messageId)}`,
      { kind: 'silent' }), // repeated background poll — don't flicker the bar
  genieQueryResult: (conversationId: string, messageId: string, attachmentId: string) =>
    getJson<{ columns: string[]; rows: string[][] }>(
      `${BASE}/genie-query-result?conversationId=${encodeURIComponent(conversationId)}&messageId=${encodeURIComponent(messageId)}&attachmentId=${encodeURIComponent(attachmentId)}`, // reconstructed (line cut off at right edge)
    ),
  // — Source systems ————————————————————————————————————
  sourceSystems: () =>
    getJson<{ sourceSystems: string[]; defaultSourceSystem: string; details?: { name: string; description: string | null; isDefault: boolean }[] }>(`${BASE}/source-systems`),
  updateSourceSystem: (name: string, newName: string, description: string | null) =>
    sendJson<{ ok: boolean; name: string; isDefault: boolean; warnings: string[] }>('PUT', `${BASE}/source-systems`, { name, newName, description }, { kind: 'long', label: 'Updating source system' }),
  createSourceSystem: (name: string, description?: string) =>
    sendJson<{ ok: boolean; name: string }>('POST', `${BASE}/source-systems`, { name, description }),
  deleteSourceSystem: (name: string) =>
    sendJson<{ ok: boolean }>('DELETE', `${BASE}/source-systems?name=${encodeURIComponent(name)}`, {}),
  sourceSystemInstructions: (sourceSystem: string) =>
    getJson<{ sourceSystem: string; instructions: string; updatedBy: string | null; updatedAt: string | null }>(
      `${BASE}/source-system-instructions?sourceSystem=${encodeURIComponent(sourceSystem)}`,
    ),
  saveSourceSystemInstructions: (sourceSystem: string, instructions: string) =>
    sendJson<{ ok: boolean; sourceSystem: string }>('PUT', `${BASE}/source-system-instructions`, { sourceSystem, instructions }),
  projects: () => getJson<{ projects: Project[]; defaultSourceSystem: string; totalTargets: number }>(`${BASE}/projects`),
  createProject: (payload: { name: string; sourceSystem: string; description?: string; vendorCode?: string; schemaVersionId?: string }) =>
    sendJson<{ ok: boolean; projectId: string; name: string; sourceSystem: string; vendorCode: string | null }>('POST', `${BASE}/projects`, payload),
  updateProject: (payload: { projectId: string; name?: string; description?: string; vendorCode?: string | null; schemaVersionId?: string }) =>
    sendJson<{ ok: boolean }>('PUT', `${BASE}/projects`, payload),
  deleteProject: (projectId: string) =>
    sendJson<{ ok: boolean }>('DELETE', `${BASE}/projects?projectId=${encodeURIComponent(projectId)}`, {}),
  vendors: () => getJson<{ vendors: Vendor[] }>(`${BASE}/vendors`),
  createVendor: (name: string, code: string, description?: string) =>
    sendJson<{ ok: boolean; vendorCode: string; name: string }>('POST', `${BASE}/vendors`, { name, code, description }),
  updateVendor: (code: string, name: string, description: string | null) =>
    sendJson<{ ok: boolean }>('PUT', `${BASE}/vendors`, { code, name, description }),
  deleteVendor: (code: string) =>
    sendJson<{ ok: boolean }>('DELETE', `${BASE}/vendors?code=${encodeURIComponent(code)}`, {}),
  whoami: () => getJson<{ email: string; role: Role }>(`${BASE}/whoami`),
  approvalTransition: (itemId: string, action: ApprovalAction, note?: string) =>
    sendJson<{ ok: boolean; from: string; to: string }>('POST', `${BASE}/approval-transition`, { itemId, action, note }),
  roles: () => getJson<{ groups: RoleGroup[]; members: RoleMember[]; bootstrapAdmins: string[]; error: string | null }>(`${BASE}/roles`),
  principals: () => getJson<WorkspacePrincipals>(`${BASE}/principals`),
  setRole: (userEmail: string, role: Role, principalType: PrincipalType = 'user') =>
    sendJson<{ ok: boolean; group: string; changes: string[] }>('POST', `${BASE}/roles`, { userEmail, role, principalType }, { kind: 'long', label: 'Updating role group membership' }),
  deleteRole: (userEmail: string, principalType: PrincipalType = 'user') =>
    sendJson<{ ok: boolean; changes: string[] }>('DELETE', `${BASE}/roles?userEmail=${encodeURIComponent(userEmail)}&principalType=${principalType}`, {}, { kind: 'long', label: 'Removing from role groups' }),
  provisionRoleGroups: () =>
    sendJson<{ results: { role: Role; group: string; found: boolean; permissions: PermissionResult[] }[] }>('POST', `${BASE}/roles/provision`, {}, { kind: 'long', label: 'Applying role group permissions' }),
  history: (status: string, approval?: string, sourceSystem?: string, projectId?: string) =>
    getJson<{ rows: HistoryRow[] }>(
      `${BASE}/history?status=${encodeURIComponent(status)}${approval ? `&approval=${encodeURIComponent(approval)}` : ''}${sourceSystem ? `&sourceSystem=${encodeURIComponent(sourceSystem)}` : ''}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  historyItem: (runId: string, sourceTable: string) =>
    getJson<{ item: HistoryItemDetail | null }>(
      `${BASE}/history-item?runId=${encodeURIComponent(runId)}&sourceTable=${encodeURIComponent(sourceTable)}`,
    ),
  deleteHistoryItem: (itemId: string) =>
    sendJson<{ ok: boolean }>('DELETE', `${BASE}/history-item?itemId=${encodeURIComponent(itemId)}`, {}),
  examples: (sourceSystem?: string) =>
    getJson<{ examples: MappingExample[] }>(`${BASE}/examples${sourceSystem ? `?sourceSystem=${encodeURIComponent(sourceSystem)}` : ''}`),
  saveExample: (payload: {
    targetTable: string;
    sourceSignature?: string;
    sourceColumns?: string;
    generatedSql: string;
    notes?: string;
    approved?: boolean;
    sourceSystem?: string;
    projectId?: string;
  }) => sendJson<{ ok: boolean; exampleId: string }>('POST', `${BASE}/examples`, payload),
  updateExample: (payload: {
    exampleId: string;
    targetTable: string;
    sourceSignature?: string;
    sourceColumns?: string;
    generatedSql: string;
    notes?: string;
    approved?: boolean;
    sourceSystem?: string;
  }) => sendJson<{ ok: boolean }>('PUT', `${BASE}/examples`, payload),
  deleteExample: (exampleId: string) =>
    sendJson<{ ok: boolean }>('DELETE', `${BASE}/examples?exampleId=${encodeURIComponent(exampleId)}`, {}),

  // ---- Reference documents (Vector Search grounding) ----
  referenceDocs: {
    status: () => getJson<ReferenceDocsStatus>(`${BASE}/reference-docs/status`),
    list: (sourceSystem?: string) =>
      getJson<{ files: ReferenceDoc[]; error?: string; needsReauth?: boolean }>(
        `${BASE}/reference-docs${sourceSystem ? `?sourceSystem=${encodeURIComponent(sourceSystem)}` : ''}`,
      ),
    // Streams the raw file body; the server writes it straight to the volume.
    upload: (file: File, sourceSystem?: string) =>
      trackActivity({ kind: 'long', label: `Uploading ${file.name}` }, async () => {
        const qs = `name=${encodeURIComponent(file.name)}${sourceSystem ? `&sourceSystem=${encodeURIComponent(sourceSystem)}` : ''}`;
        const res = await fetch(`${BASE}/reference-docs/upload?${qs}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        });
        const body = (await res.json()) as { ok?: boolean; name?: string; error?: string; indexing?: boolean };
        if (!res.ok || body.error) throw new Error(body.error ?? `Upload failed: ${res.status}`);
        return body;
      }),
    remove: (name: string, sourceSystem?: string) =>
      sendJson<{ ok: boolean }>('DELETE', `${BASE}/reference-docs?name=${encodeURIComponent(name)}${sourceSystem ? `&sourceSystem=${encodeURIComponent(sourceSystem)}` : ''}`, {}),
    // Fetch the raw file body and trigger a browser "Save as" via an object URL.
    // (A plain <a href> can't send the credentialed request the API needs.)
    download: (name: string, sourceSystem?: string) =>
      trackActivity({ kind: 'long', label: `Downloading ${name}` }, async () => {
        const qs = `name=${encodeURIComponent(name)}${sourceSystem ? `&sourceSystem=${encodeURIComponent(sourceSystem)}` : ''}`;
        const res = await fetch(`${BASE}/reference-docs/download?${qs}`, { credentials: 'include' });
        if (!res.ok) {
          let msg = `Download failed: ${res.status}`;
          try { const body = (await res.json()) as { error?: string }; if (body.error) msg = body.error; } catch { /* non-JSON error body */ }
          throw new Error(msg);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }),
    sync: () => sendJson<{ ok: boolean }>('POST', `${BASE}/reference-docs/sync`, {}, { kind: 'long', label: 'Re-indexing reference documents' }),
  },
  getUserPrefs: () => getJson<{ prefs: UserPrefs }>(`${BASE}/user-prefs`),
  saveUserPrefs: (prefs: UserPrefs) => sendJson<{ ok: boolean }>('POST', `${BASE}/user-prefs`, prefs),
  retrievalStatus: () =>
    getJson<{ configured: boolean; endpoint: string | null; index: string | null; corpusTable: string; corpusRows: number | null; lastRebuiltAt: string | null; indexReady: boolean | null }>(
      `${BASE}/retrieval-status`,
    ),
  rebuildRetrieval: () => sendJson<{ ok: boolean; corpusRows: number }>('POST', `${BASE}/retrieval-rebuild`, {}, { kind: 'long', label: 'Rebuilding retrieval index' }), // reconstructed (label cut off at right edge)
  usageStats: () => getJson<UsageStats>(`${BASE}/usage-stats`),
  getPromptProfile: () =>
    getJson<{ profile: PromptProfile; options: PromptProfile[]; limits: Record<string, number> }>(`${BASE}/prompt-profile`),
  setPromptProfile: (profile: PromptProfile) =>
    sendJson<{ ok: boolean; profile: PromptProfile; limits: Record<string, number> }>('POST', `${BASE}/prompt-profile`, { profile }),
  getModelSelection: () => getJson<ModelSelection>(`${BASE}/model-selection`),
  setModelSelection: (sel: ModelSelection) =>
    sendJson<{ ok: boolean } & ModelSelection>('POST', `${BASE}/model-selection`, sel),
};

/** Prompt Sizing profile — a single admin dial over the generation/prompt caps. */
export type PromptProfile = 'conservative' | 'balanced' | 'generous';

/** Task-size model auto-selection config (admin). */
export interface ModelSelection {
  autoSelect: boolean;
  tiers: { strong: string; standard: string; light: string };
}
