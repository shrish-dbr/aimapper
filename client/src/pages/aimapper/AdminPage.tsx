import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Button,
  Input,
  Label,
  Skeleton,
  Alert,
  AlertTitle,
  AlertDescription,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@databricks/appkit-ui/react';
import { SearchableSelect } from './SearchableSelect';
import { ShieldAlert, UserPlus, Trash2, Info, RefreshCw, Plus, Users, KeyRound } from 'lucide-react';
import { api, type Role, type RoleAssignment, type KaDetails, type Vendor, type PromptProfile, type PrincipalType, type WorkspacePrincipals, type PermissionResult } from '../../lib/aimapperApi';
import { PrincipalPicker, type PickedPrincipal } from './PrincipalPicker';
import { useRole } from '../../lib/roleContext';
import { ConfigPanel } from './ConfigPage';
import { useSort, SortHead } from '../../lib/useSort';
import { PageHeader, Panel, StatusPill, Tag, Chip, Mono, Avatar, SearchField } from '../../components/studio';
import { splitDateTime } from '../../lib/display';

type UsageByUser = Awaited<ReturnType<typeof api.usageStats>>['byUser'][number];
type UsageRecent = Awaited<ReturnType<typeof api.usageStats>>['recent'][number];
function byUserSortValue(u: UsageByUser, key: string): string | number {
  switch (key) {
    case 'user': return (u.userEmail ?? '').toLowerCase();
    case 'total': return u.totalTokens;
    case 'in': return u.promptTokens;
    case 'out': return u.completionTokens;
    case 'runs': return u.runs;
    default: return '';
  }
}
function recentSortValue(r: UsageRecent, key: string): string | number {
  switch (key) {
    case 'when': return String(r.createdAt ?? '');
    case 'user': return (r.createdBy ?? '').toLowerCase();
    case 'source_system': return (r.sourceSystem ?? '').toLowerCase();
    case 'target': return (r.targetTable ?? '').toLowerCase();
    case 'tokens': return r.totalTokens;
    default: return '';
  }
}

// Admin sections as ONE horizontal menu (underline tabs, styled globally via
// [data-slot=tabs-*]). Ordered as a setup flow: people → catalog → knowledge &
// retrieval → model tuning → monitoring. Scrolls horizontally on narrow screens
// instead of wrapping.
const ADMIN_TABS: { value: string; label: string }[] = [
  { value: 'roles', label: 'Roles & permissions' },
  { value: 'sourceSystems', label: 'Source systems' },
  { value: 'vendors', label: 'Vendors' },
  { value: 'config', label: 'Target schema' },
  { value: 'ka', label: 'Knowledge Assistant' },
  { value: 'retrieval', label: 'Vector index' },
  { value: 'promptSizing', label: 'Tuning' },
  { value: 'usage', label: 'Usage' },
];

/** Section heading at the top of each admin tab: title, description, actions. */
function SectionIntro({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 max-w-3xl">
        <h2 className="text-[1.375rem] font-bold tracking-tight text-foreground">{title}</h2>
        {children && <div className="mt-1 text-sm text-muted-foreground">{children}</div>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

/** Inline monospace token (env var / script name). */
function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.8em] text-foreground">{children}</code>;
}

/** Square ink/red legend swatch used by the token KPIs. */
function Swatch({ className }: { className: string }) {
  return <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-[3px] ${className}`} />;
}

const ROLES: Role[] = ['viewer', 'editor', 'admin'];
const ROLE_DESC: Record<Role, string> = {
  viewer: 'Generate SQL & submit mappings for review',
  editor: 'Everything a viewer can, plus approve/reject reviews & curate references',
  admin: 'Full control: config, deletes, and role management',
};

function roleBadge(role: string) {
  const tone = role === 'admin' ? 'brand' : role === 'editor' ? 'success' : 'neutral';
  return <StatusPill tone={tone}>{role.charAt(0).toUpperCase() + role.slice(1)}</StatusPill>;
}

// --- Knowledge Assistant admin panel ---------------------------------------
// The KA REST resource shape isn't strongly typed, so read known fields
// defensively and fall back gracefully.
function str(o: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

/** Format an ISO/epoch timestamp as a short local date-time, or "never". */
function fmtWhen(v: string | number | null | undefined): string {
  if (v == null || v === '') return 'never';
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

function kaStatusBadge(status: string | null) {
  const s = (status ?? '').toUpperCase();
  if (s === 'ONLINE' || s === 'READY' || s === 'ACTIVE') return <StatusPill tone="success">{status}</StatusPill>;
  if (s === 'CREATING' || s === 'UPDATING' || s.includes('SYNC') || s.includes('PENDING')) return <StatusPill tone="warning">{status}</StatusPill>;
  if (s === 'OFFLINE' || s.includes('FAIL') || s.includes('ERROR')) return <StatusPill tone="danger">{status}</StatusPill>;
  return <StatusPill tone="neutral">{status ?? 'Unknown'}</StatusPill>;
}

/** Extract knowledge-source rows from the raw KA resource. The KA API exposes a
 * `state` per source and the volume `files.path`, but no last-sync timestamp. */
function kaSources(details: Record<string, unknown> | null): { name: string; status: string | null; path: string | null }[] {
  if (!details) return [];
  const raw = details.knowledge_sources ?? details.sources;
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => {
    const o = s as Record<string, unknown>;
    const files = (o.files ?? null) as Record<string, unknown> | null;
    return {
      name: str(o, 'display_name', 'name') ?? '(source)',
      status: str(o, 'state', 'status'),
      path: str(files, 'path'),
    };
  });
}

function KnowledgeAssistantPanel() {
  const [data, setData] = useState<KaDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.kaDetails());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleSync() {
    setSyncing(true);
    setMsg(null);
    setError(null);
    try {
      await api.referenceDocs.sync();
      setMsg('Re-sync started. Indexing takes a few minutes; refresh to see the updated status.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  if (loading) return <div className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-24 w-full" /></div>;

  if (data && !data.configured) {
    return (
      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Knowledge Assistant not configured</AlertTitle>
        <AlertDescription>
          <p>
          Reference-document grounding is disabled. To enable it, run <Code>setup/create_ka.sh</Code> and set{' '}
          <Code>AIMAPPER_KA_ENDPOINT</Code> (and <Code>AIMAPPER_KA_ID</Code> for re-sync) in <Code>app.yaml</Code>.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  const details = data?.details ?? null;
  const status = str(details, 'state', 'status');
  const displayName = str(details, 'display_name') ?? 'Reference Docs';
  // create_time may be an ISO string (CLI shape) or ms-epoch number (SP shape).
  const createdRaw = details?.create_time ?? details?.created_at ?? null;
  const created =
    typeof createdRaw === 'number' ? new Date(createdRaw).toISOString().slice(0, 16).replace('T', ' ')
    : typeof createdRaw === 'string' && createdRaw ? createdRaw.slice(0, 16).replace('T', ' ')
    : null;
  const sources = kaSources(details);

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">{displayName}</CardTitle>
            <CardDescription>Grounds attribute discovery and SQL generation on your reference documents.</CardDescription>
          </div>
          <div className="flex items-center gap-3">
            {kaStatusBadge(status)}
            {data?.canSync && (
              <Button size="sm" onClick={() => void handleSync()} disabled={syncing}>
                <RefreshCw className={`h-4 w-4 mr-1.5 ${syncing ? 'animate-spin' : ''}`} /> Re-sync
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="border-t pt-4">
          <dl className="grid grid-cols-1 sm:grid-cols-[11rem_1fr] gap-x-6 gap-y-3 text-sm items-center">
            <dt className="text-muted-foreground">Query endpoint</dt>
            <dd className="font-mono text-xs break-all">{data?.endpoint ?? '—'}</dd>
            <dt className="text-muted-foreground">KA id</dt>
            <dd className="font-mono text-xs break-all">{data?.kaId ?? '—'}</dd>
            <dt className="text-muted-foreground">Documents volume</dt>
            <dd className="font-mono text-xs break-all">{data?.volume ?? '—'}</dd>
            {created && (<><dt className="text-muted-foreground">Created</dt><dd className="text-xs">{created}</dd></>)}
            {data?.canSync && (
              <>
                <dt className="text-muted-foreground">Sync state</dt>
                <dd>
                  {syncing || (data?.syncState ?? '').toUpperCase() === 'UPDATING'
                    ? <StatusPill tone="warning">Syncing…</StatusPill>
                    : (data?.syncState ?? '').toUpperCase() === 'UPDATED'
                    ? <StatusPill tone="success">Up to date</StatusPill>
                    : <StatusPill tone="neutral">Unknown</StatusPill>}
                </dd>
                <dt className="text-muted-foreground">Last synced</dt>
                <dd className="text-xs">{fmtWhen(data?.lastSyncedAt)}</dd>
              </>
            )}
          </dl>
          {msg && <p className="text-sm text-muted-foreground mt-3">{msg}</p>}
          {!details && (
            <p className="text-xs text-muted-foreground mt-3">
              Live KA status is unavailable (the assistant may be unreachable or still provisioning). The configuration
              above is taken from the app environment.
            </p>
          )}
        </CardContent>
      </Card>

      {sources.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Knowledge sources</CardTitle>
            <CardDescription>Document sources indexed by the assistant.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Volume path</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.map((s, i) => (
                  // eslint-disable-next-line react/no-array-index-key -- KA source order is stable and names may repeat
                  <TableRow key={`${s.name}-${i}`}>
                    <TableCell className="text-sm font-medium">{s.name}</TableCell>
                    <TableCell>{kaStatusBadge(s.status)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground break-all">{s.path ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// --- Source systems admin panel --------------------------------------------
function SourceSystemsPanel() {
  const [sourceSystems, setSourceSystems] = useState<string[]>([]);
  const [defaultSourceSystem, setDefaultSourceSystem] = useState('Epic');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.sourceSystems();
      setSourceSystems(d.sourceSystems);
      setDefaultSourceSystem(d.defaultSourceSystem);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) { setMsg('Enter a source system name.'); return; }
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      await api.createSourceSystem(name, newDesc.trim() || undefined);
      setMsg(`Source system '${name}' created.`);
      setNewName('');
      setNewDesc('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(name: string) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await api.deleteSourceSystem(name);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionIntro title="Source systems">
        Source systems are the EHR system TYPES your source data comes from (Epic, Cerner, …). Each project targets one
        source system; every mapping inherits its project&apos;s source system. <span className="font-medium text-foreground">{defaultSourceSystem}</span> is the default.
      </SectionIntro>

      {error && (
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a source system</CardTitle>
          <CardDescription>Create a new source EHR system type. Names are unique.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-1 w-56">
              <Label>Source system name</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Meditech" />
            </div>
            <div className="space-y-1 flex-1 min-w-56">
              <Label>Description (optional)</Label>
              <Input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Short note" />
            </div>
            <Button onClick={() => void handleCreate()} disabled={busy}>
              <Plus className="h-4 w-4 mr-1.5" /> {busy ? 'Saving…' : 'Add Source System'}
            </Button>
          </div>
          {msg && <p className="text-sm text-muted-foreground mt-3">{msg}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Source systems</CardTitle>
          <CardDescription>The default source system and in-use source systems cannot be deleted.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading && <div className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>}
          {!loading && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source System</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sourceSystems.map((d) => {
                  const isDefault = d.toLowerCase() === defaultSourceSystem.toLowerCase();
                  return (
                    <TableRow key={d}>
                      <TableCell className="text-sm font-medium">
                        {d}
                        {isDefault && <Tag className="ml-2 uppercase tracking-wide">Default</Tag>}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="icon-sm"
                          onClick={() => void handleDelete(d)}
                          disabled={isDefault || busy}
                          title={isDefault ? 'The default source system cannot be deleted' : 'Delete source system'}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// --- Vendors admin panel ----------------------------------------------------
// EHR vendors (name + unique code + description) selectable when creating a project.
// Admins curate the list; a vendor can't be deleted while a project references it.
function VendorsPanel() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newCode, setNewCode] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const v = await api.vendors();
      setVendors(v.vendors);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleCreate() {
    const name = newName.trim();
    const code = newCode.trim();
    if (!name || !code) { setMsg('Enter a vendor name and code.'); return; }
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      await api.createVendor(name, code, newDesc.trim() || undefined);
      setMsg(`Vendor '${name}' created.`);
      setNewName('');
      setNewCode('');
      setNewDesc('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(code: string) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await api.deleteVendor(code);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionIntro title="Vendors">
        Vendors are the EHR products your source data comes from. Each has a display name, a unique code, and an
        optional description. They appear in the vendor dropdown when creating a project.
      </SectionIntro>

      {error && (
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a vendor</CardTitle>
          <CardDescription>The code is a short unique identifier (no spaces), e.g. EPIC or ORCL_CERNER.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-1 w-56">
              <Label>Vendor name</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Epic Systems" />
            </div>
            <div className="space-y-1 w-40">
              <Label>Vendor code</Label>
              <Input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="e.g. EPIC" />
            </div>
            <div className="space-y-1 flex-1 min-w-56">
              <Label>Description (optional)</Label>
              <Input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Short note" />
            </div>
            <Button onClick={() => void handleCreate()} disabled={busy}>
              <Plus className="h-4 w-4 mr-1.5" /> {busy ? 'Saving…' : 'Add Vendor'}
            </Button>
          </div>
          {msg && <p className="text-sm text-muted-foreground mt-3">{msg}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Vendors</CardTitle>
          <CardDescription>A vendor in use by a project cannot be deleted.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading && <div className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>}
          {!loading && vendors.length === 0 && <p className="text-sm text-muted-foreground">No vendors yet. Add one above.</p>}
          {!loading && vendors.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {vendors.map((v) => (
                  <TableRow key={v.vendor_code}>
                    <TableCell className="text-sm font-medium">{v.name}</TableCell>
                    <TableCell className="text-sm"><Tag><Mono className="text-[0.75rem]">{v.vendor_code}</Mono></Tag></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{v.description ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="icon-sm" onClick={() => void handleDelete(v.vendor_code)} disabled={busy} title="Delete vendor">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// --- Retrieval (Vector Search) admin panel ---------------------------------
function RetrievalPanel() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.retrievalStatus>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.retrievalStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleRebuild() {
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const r = await api.rebuildRetrieval();
      setMsg(`Corpus rebuilt: ${r.corpusRows} record(s). Re-embedding the index usually takes 2–5 minutes — this refreshes automatically.`);
      // Keep the icon spinning while the index re-embeds; poll `indexReady`.
      const deadline = Date.now() + 10 * 60 * 1000;
      await new Promise((res) => setTimeout(res, 4000));
      while (Date.now() < deadline) {
        let st: Awaited<ReturnType<typeof api.retrievalStatus>> | null = null;
        try { st = await api.retrievalStatus(); } catch { /* transient */ }
        if (st) setData(st);
        if (st && st.indexReady === true) {
          setMsg(`Corpus rebuilt (${r.corpusRows} record(s)) and the index is ready.`);
          break;
        }
        await new Promise((res) => setTimeout(res, 15000));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-24 w-full" /></div>;

  return (
    <div className="space-y-6">
      <SectionIntro title="Vector index">
        Mapping generation grounds on prior work by retrieving the most similar approved examples + approved history.
        With Vector Search configured, retrieval is <strong>semantic</strong> over the whole corpus (hard-filtered by
        project + target). Otherwise it falls back to a lexical heuristic (recent + column-name overlap).
      </SectionIntro>

      {error && (
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {data && !data.configured && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>Semantic retrieval not configured</AlertTitle>
          <AlertDescription>
            <p>
            Using the lexical fallback. To enable Vector Search, run <Code>setup/create_vector_index.sh</Code> and set{' '}
            <Code>AIMAPPER_VS_ENDPOINT</Code> + <Code>AIMAPPER_VS_INDEX</Code> in <Code>app.yaml</Code>.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Retrieval index</CardTitle>
            <CardDescription>Approved examples + approved history, embedded for semantic few-shot retrieval.</CardDescription>
          </div>
          <div className="flex items-center gap-3">
            {data?.configured ? (
              <StatusPill tone="success">Vector Search</StatusPill>
            ) : (
              <StatusPill tone="neutral">Lexical fallback</StatusPill>
            )}
            <Button size="sm" onClick={() => void handleRebuild()} disabled={busy || !data?.configured}>
              <RefreshCw className={`h-4 w-4 mr-1.5 ${busy ? 'animate-spin' : ''}`} /> {busy ? 'Rebuilding…' : 'Rebuild Corpus'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="border-t pt-4">
          <dl className="grid grid-cols-1 sm:grid-cols-[11rem_1fr] gap-x-6 gap-y-3 text-sm items-center">
            <dt className="text-muted-foreground">Endpoint</dt>
            <dd className="font-mono text-xs break-all">{data?.endpoint ?? '—'}</dd>
            <dt className="text-muted-foreground">Index</dt>
            <dd className="font-mono text-xs break-all">{data?.index ?? '—'}</dd>
            <dt className="text-muted-foreground">Corpus table</dt>
            <dd className="font-mono text-xs break-all">{data?.corpusTable ?? '—'}</dd>
            <dt className="text-muted-foreground">Corpus rows</dt>
            <dd>{data?.corpusRows ?? '—'}</dd>
            {data?.configured && (
              <>
                <dt className="text-muted-foreground">Index status</dt>
                <dd>
                  {busy || data?.indexReady === false ? (
                    <StatusPill tone="warning">Re-embedding…</StatusPill>
                  ) : data?.indexReady ? (
                    <StatusPill tone="success">Ready</StatusPill>
                  ) : (
                    <StatusPill tone="neutral">Unknown</StatusPill>
                  )}
                </dd>
                <dt className="text-muted-foreground">Last rebuilt</dt>
                <dd className="text-xs">{fmtWhen(data?.lastRebuiltAt)}</dd>
              </>
            )}
          </dl>
          {msg && <p className="text-sm text-muted-foreground mt-3">{msg}</p>}
        </CardContent>
      </Card>
    </div>
  );
}

// --- Prompt Sizing profile admin panel -------------------------------------
const PROMPT_PROFILE_INFO: Record<PromptProfile, { label: string; blurb: string }> = {
  conservative: { label: 'Conservative', blurb: 'Smaller prompts & output — cheaper and faster. Best for simple, narrow mappings.' },
  balanced: { label: 'Balanced (default)', blurb: 'Sensible sizes for most mappings — the recommended default.' },
  generous: { label: 'Generous', blurb: 'Largest reference examples and longest generated SQL. Use for big/complex mappings (large reference SQL, wide targets) that would otherwise truncate.' },
};

function PromptSizingPanel() {
  const [profile, setProfile] = useState<PromptProfile | null>(null);
  const [options, setOptions] = useState<PromptProfile[]>(['conservative', 'balanced', 'generous']);
  const [limits, setLimits] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.getPromptProfile();
      setProfile(r.profile);
      if (r.options?.length) setOptions(r.options);
      setLimits(r.limits ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleChange(next: PromptProfile) {
    if (next === profile) return;
    setBusy(true);
    setMsg(null);
    setError(null);
    const prev = profile;
    setProfile(next); // optimistic
    try {
      const r = await api.setPromptProfile(next);
      setProfile(r.profile);
      setLimits(r.limits ?? null);
      setMsg(`Prompt sizing set to "${PROMPT_PROFILE_INFO[r.profile]?.label ?? r.profile}". It applies to the next mapping generation.`);
    } catch (err) {
      setProfile(prev); // revert on failure
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-24 w-full" /></div>;

  return (
    <div className="space-y-6">
      <SectionIntro title="Tuning">
        One dial that sizes mapping generation: the LLM output-token budget plus the prompt, reference-example,
        grounding, and data-sample caps. Raise it when large reference examples or wide targets cause the generated
        SQL to be <strong>truncated</strong>; lower it to cut cost and latency on simple mappings.
      </SectionIntro>

      {error && (
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Prompt sizing profile</CardTitle>
          <CardDescription>Applies globally to every mapping run. Only admins can change it.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-1 w-72">
              <Label>Profile</Label>
              <SearchableSelect
                value={profile ?? 'balanced'}
                onValueChange={(v) => void handleChange(v as PromptProfile)}
                disabled={busy}
                className="w-full"
                options={options.map((p) => ({ value: p, label: PROMPT_PROFILE_INFO[p]?.label ?? p }))}
              />
            </div>
          </div>
          {profile && (
            <p className="text-sm text-muted-foreground mt-3">{PROMPT_PROFILE_INFO[profile]?.blurb}</p>
          )}
          {limits && (
            <p className="text-xs text-muted-foreground mt-2">
              Output tokens: <strong>{limits.genMaxTokens?.toLocaleString()}</strong> · Identify tokens:{' '}
              <strong>{limits.identifyMaxTokens?.toLocaleString()}</strong> · Max prompt:{' '}
              <strong>{limits.maxPromptChars?.toLocaleString()}</strong> chars · Per-example cap:{' '}
              <strong>{limits.maxExampleSqlChars?.toLocaleString()}</strong> chars · Few-shot items:{' '}
              <strong>{limits.maxFewshotItems}</strong>
            </p>
          )}
          {msg && <p className="text-sm text-muted-foreground mt-3">{msg}</p>}
        </CardContent>
      </Card>
    </div>
  );
}

// --- Task-size model auto-selection admin panel ----------------------------
const MODEL_TIER_INFO: { key: 'strong' | 'standard' | 'light'; label: string; blurb: string }[] = [
  { key: 'strong', label: 'Strong', blurb: 'Large/complex mappings — wide targets, big reference SQL, many sources.' },
  { key: 'standard', label: 'Standard', blurb: 'Typical mappings.' },
  { key: 'light', label: 'Light', blurb: 'Small, narrow mappings — cheapest/fastest.' },
];

function ModelSelectionPanel() {
  const NONE = '__none__';
  const [autoSelect, setAutoSelect] = useState(false);
  const [tiers, setTiers] = useState<{ strong: string; standard: string; light: string }>({ strong: '', standard: '', light: '' });
  const [endpoints, setEndpoints] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sel, eps] = await Promise.all([api.getModelSelection(), api.endpoints()]);
      setAutoSelect(sel.autoSelect);
      setTiers(sel.tiers);
      setEndpoints((eps.endpoints ?? []).map((e) => e.name));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(next: { autoSelect: boolean; tiers: { strong: string; standard: string; light: string } }) {
    setBusy(true);
    setMsg(null);
    setError(null);
    const prev = { autoSelect, tiers };
    setAutoSelect(next.autoSelect); // optimistic
    setTiers(next.tiers);
    try {
      const r = await api.setModelSelection(next);
      setAutoSelect(r.autoSelect);
      setTiers(r.tiers);
      setMsg('Model selection saved. It applies to the next mapping run.');
    } catch (err) {
      setAutoSelect(prev.autoSelect); // revert
      setTiers(prev.tiers);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-24 w-full" /></div>;

  const epOptions = [{ value: NONE, label: '— none —' }, ...endpoints.map((e) => ({ value: e, label: e }))];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Model selection</CardTitle>
        <CardDescription>Optionally let the app pick the LLM endpoint by task size. Off by default; users can always override per run. Only admins can change it.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-1 w-72">
          <Label>Auto-select model by task size</Label>
          <SearchableSelect
            value={autoSelect ? 'on' : 'off'}
            onValueChange={(v) => void save({ autoSelect: v === 'on', tiers })}
            disabled={busy}
            className="w-full"
            options={[{ value: 'off', label: 'Off (use the picked endpoint)' }, { value: 'on', label: 'On (route by task size)' }]}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {MODEL_TIER_INFO.map((t) => (
            <div key={t.key} className="space-y-1">
              <Label>{t.label} tier endpoint</Label>
              <SearchableSelect
                value={tiers[t.key] || NONE}
                onValueChange={(v) => void save({ autoSelect, tiers: { ...tiers, [t.key]: v === NONE ? '' : v } })}
                disabled={busy || !autoSelect}
                className="w-full"
                options={epOptions}
              />
              <p className="text-xs text-muted-foreground">{t.blurb}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Routing: large/complex → Strong; small/narrow → Light; otherwise Standard. Only endpoints you can query appear here, and a run never routes to an endpoint the user can&apos;t access (it falls back).
        </p>
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}

// --- Token usage admin panel -----------------------------------------------
function UsagePanel() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.usageStats>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const d = await api.usageStats();
        if (active) setData(d);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const nf = (n: number) => n.toLocaleString();
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const byUserRows = useMemo(() => {
    const rows = data?.byUser ?? [];
    return needle ? rows.filter((u) => (u.userEmail ?? '').toLowerCase().includes(needle)) : rows;
  }, [data, needle]);
  const recentRows = useMemo(() => {
    const rows = data?.recent ?? [];
    return needle
      ? rows.filter((r) => [r.createdBy, r.sourceSystem, r.targetTable].some((v) => String(v ?? '').toLowerCase().includes(needle)))
      : rows;
  }, [data, needle]);
  const byUser = useSort<UsageByUser>(byUserRows, byUserSortValue, 'total', 'desc');
  const recent = useSort<UsageRecent>(recentRows, recentSortValue, 'when', 'desc');

  if (loading) return <div className="space-y-2"><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div>;

  // Display-only split of the total into prompt / completion / unsplit remainder.
  const total = data?.total.totalTokens ?? 0;
  const promptT = data?.total.promptTokens ?? 0;
  const complT = data?.total.completionTokens ?? 0;
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  const remainder = Math.max(0, total - promptT - complT);
  const barW = (n: number) => `${total > 0 ? Math.min(100, (n / total) * 100) : 0}%`;

  return (
    <div className="space-y-6">
      <SectionIntro title="Token usage">
        LLM tokens across mapping tasks. Each task counts both steps — attribute discovery and SQL generation.
        Tokens are recorded from the serving-endpoint response; older runs created before tracking show zero.
      </SectionIntro>

      <SearchField value={q} onChange={setQ} placeholder="Filter by user, source system, or target…" className="max-w-sm" />

      {error && (
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Totals */}
      <Panel className="px-6 py-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          <div>
            <p className="eyebrow">Total tokens</p>
            <p className="mt-1.5 text-[2.25rem] leading-none font-bold tracking-tight tabular-nums">{nf(total)}</p>
            <p className="mt-2 text-[0.8125rem] text-muted-foreground">across {nf(data?.total.runs ?? 0)} run{(data?.total.runs ?? 0) === 1 ? '' : 's'}</p>
          </div>
          <div>
            <p className="eyebrow flex items-center gap-2"><Swatch className="bg-ink dark:bg-ink-muted" /> Prompt (in)</p>
            <p className="mt-1.5 text-[2.25rem] leading-none font-bold tracking-tight tabular-nums">{nf(promptT)}</p>
            <p className="mt-2 text-[0.8125rem] text-muted-foreground">{pct(promptT)}% of total</p>
          </div>
          <div>
            <p className="eyebrow flex items-center gap-2"><Swatch className="bg-brand" /> Completion (out)</p>
            <p className="mt-1.5 text-[2.25rem] leading-none font-bold tracking-tight tabular-nums">{nf(complT)}</p>
            <p className="mt-2 text-[0.8125rem] text-muted-foreground">{pct(complT)}% of total</p>
          </div>
        </div>
        <div className="mt-6 flex h-2.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full bg-ink dark:bg-ink-muted" style={{ width: barW(promptT) }} />
          <div className="h-full bg-brand border-l-2 border-card" style={{ width: barW(complT) }} />
        </div>
        {remainder > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Remaining {pct(remainder)}% ({nf(remainder)}) is reported by the endpoint but not split into prompt or completion.
          </p>
        )}
      </Panel>

      {/* By user */}
      <Panel className="overflow-hidden">
        <div className="px-6 pt-5 pb-3">
          <h3 className="text-[1.0625rem] font-bold tracking-tight">By user</h3>
          <p className="text-sm text-muted-foreground mt-0.5">Total token consumption per user, highest first.</p>
        </div>
        {byUser.sorted.length === 0 ? (
          <p className="px-6 pb-5 text-sm text-muted-foreground">{needle ? `No users match “${q}”.` : 'No token usage recorded yet.'}</p>
        ) : (
          <Table className="[&_th:first-child]:pl-6 [&_td:first-child]:pl-6 [&_th:last-child]:pr-6 [&_td:last-child]:pr-6">
            <TableHeader>
              <TableRow>
                <SortHead label="User" sortKey="user" active={byUser.sortKey === 'user'} dir={byUser.sortDir} onSort={byUser.toggle} />
                <SortHead label="Total" sortKey="total" active={byUser.sortKey === 'total'} dir={byUser.sortDir} onSort={byUser.toggle} className="text-right" />
                <SortHead label="In" sortKey="in" active={byUser.sortKey === 'in'} dir={byUser.sortDir} onSort={byUser.toggle} className="text-right" />
                <SortHead label="Out" sortKey="out" active={byUser.sortKey === 'out'} dir={byUser.sortDir} onSort={byUser.toggle} className="text-right" />
                <SortHead label="Runs" sortKey="runs" active={byUser.sortKey === 'runs'} dir={byUser.sortDir} onSort={byUser.toggle} className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {byUser.sorted.map((u) => (
                <TableRow key={u.userEmail}>
                  <TableCell className="py-3">
                    <span className="flex items-center gap-3 text-sm">
                      <Avatar name={u.userEmail} size="sm" />
                      <span className="truncate">{u.userEmail}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-bold">{nf(u.totalTokens)}</TableCell>
                  <TableCell className="text-right tabular-nums">{nf(u.promptTokens)}</TableCell>
                  <TableCell className="text-right tabular-nums">{nf(u.completionTokens)}</TableCell>
                  <TableCell className="text-right tabular-nums">{nf(u.runs)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      {/* Recent tasks */}
      <Panel className="overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 px-6 pt-5 pb-3">
          <div>
            <h3 className="text-[1.0625rem] font-bold tracking-tight">Recent tasks</h3>
            <p className="text-sm text-muted-foreground mt-0.5">Per-task token consumption.</p>
          </div>
          <span className="text-[0.8125rem] text-muted-foreground">Newest first</span>
        </div>
        {recent.sorted.length === 0 ? (
          <p className="px-6 pb-5 text-sm text-muted-foreground">{needle ? `No tasks match “${q}”.` : 'No tasks with token data yet.'}</p>
        ) : (
          <Table className="[&_th:first-child]:pl-6 [&_td:first-child]:pl-6 [&_th:last-child]:pr-6 [&_td:last-child]:pr-6">
            <TableHeader>
              <TableRow>
                <SortHead label="When" sortKey="when" active={recent.sortKey === 'when'} dir={recent.sortDir} onSort={recent.toggle} />
                <SortHead label="User" sortKey="user" active={recent.sortKey === 'user'} dir={recent.sortDir} onSort={recent.toggle} />
                <SortHead label="Source System" sortKey="source_system" active={recent.sortKey === 'source_system'} dir={recent.sortDir} onSort={recent.toggle} />
                <SortHead label="Target" sortKey="target" active={recent.sortKey === 'target'} dir={recent.sortDir} onSort={recent.toggle} />
                <SortHead label="Tokens" sortKey="tokens" active={recent.sortKey === 'tokens'} dir={recent.sortDir} onSort={recent.toggle} className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.sorted.map((r) => {
                const when = splitDateTime(r.createdAt);
                return (
                  <TableRow key={r.itemId}>
                    <TableCell className="py-3">
                      <p className="text-sm font-semibold">{when.date}</p>
                      <p className="text-xs text-muted-foreground">{when.time}</p>
                    </TableCell>
                    <TableCell className="text-sm">{r.createdBy.split('@')[0]}</TableCell>
                    <TableCell><Chip>{r.sourceSystem}</Chip></TableCell>
                    <TableCell><Mono className="font-semibold">{r.targetTable}</Mono></TableCell>
                    <TableCell className="text-right tabular-nums font-bold">{nf(r.totalTokens)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  );
}

const PERM_TONE: Record<PermissionResult['status'], 'success' | 'neutral' | 'warning' | 'danger'> = {
  granted: 'success',
  already: 'neutral',
  revoked: 'warning',
  restored: 'warning',
  skipped: 'neutral',
  failed: 'danger',
};
const PERM_LABEL: Record<PermissionResult['status'], string> = {
  granted: 'Granted',
  already: 'Already had',
  revoked: 'Revoked',
  restored: 'Restored',
  skipped: 'Skipped',
  failed: 'Failed',
};

/** Per-resource outcome of the last role change (grants/revokes made as the admin). */
function PermissionResults({ title, results, onDismiss }: { title: string; results: PermissionResult[]; onDismiss: () => void }) {
  const failed = results.filter((r) => r.status === 'failed').length;
  return (
    <Panel className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-3">
        <div>
          <h3 className="text-base font-bold">{title}</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {failed
              ? `${failed} of ${results.length} resource permissions could not be applied with your credentials — fix the cause and use “Re-sync access” on the row.`
              : 'Resource permissions were applied with your credentials. Only grants made here are revoked later.'}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-6">Resource</TableHead>
            <TableHead>Access</TableHead>
            <TableHead>Result</TableHead>
            <TableHead className="pr-6">Detail</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {results.map((r, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <TableRow key={`${r.resource}-${r.access}-${i}`}>
              <TableCell className="pl-6 text-sm">{r.resource}</TableCell>
              <TableCell><Mono className="text-xs">{r.access}</Mono></TableCell>
              <TableCell><StatusPill tone={PERM_TONE[r.status]}>{PERM_LABEL[r.status]}</StatusPill></TableCell>
              <TableCell className="pr-6 text-xs text-muted-foreground max-w-[28rem] whitespace-normal break-words">{r.detail ?? ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

export function AdminPage() {
  const { role, loading: roleLoading, refresh: refreshMe, email: myEmail } = useRole();
  const [rows, setRows] = useState<RoleAssignment[]>([]);
  const [bootstrap, setBootstrap] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [picked, setPicked] = useState<PickedPrincipal | null>(null);
  const [principals, setPrincipals] = useState<WorkspacePrincipals | null>(null);
  const [principalsLoading, setPrincipalsLoading] = useState(false);
  const [permResults, setPermResults] = useState<{ title: string; results: PermissionResult[] } | null>(null);
  const [syncingKey, setSyncingKey] = useState<string | null>(null);
  const [newRole, setNewRole] = useState<Role>('editor');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.roles();
      setRows(res.roles);
      setBootstrap(res.bootstrapAdmins);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!roleLoading && role === 'admin') void load();
    else if (!roleLoading) setLoading(false);
  }, [roleLoading, role, load]);

  // Workspace users + groups for the role picker (admins only). Failure is non-fatal:
  // the picker still accepts a typed email.
  useEffect(() => {
    if (roleLoading || role !== 'admin') return;
    let cancelled = false;
    setPrincipalsLoading(true);
    api
      .principals()
      .then((p) => { if (!cancelled) setPrincipals(p); })
      .catch((err: unknown) => {
        if (!cancelled) setPrincipals({ users: [], groups: [], error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => { if (!cancelled) setPrincipalsLoading(false); });
    return () => { cancelled = true; };
  }, [roleLoading, role]);

  async function handleAssign() {
    if (!picked) { setMsg('Select a user or group.'); return; }
    const email = picked.type === 'user' ? picked.name.trim().toLowerCase() : picked.name.trim();
    setSaving(true);
    setMsg(null);
    try {
      const res = await api.setRole(email, newRole, picked.type);
      setMsg(`Set ${picked.type === 'group' ? `group ${email}` : email} to ${newRole}.`);
      if (res.permissions) setPermResults({ title: `Access for ${email} (${newRole})`, results: res.permissions });
      setPicked(null);
      await load();
      // The admin's own role may have changed (directly or via a group) → refresh identity/nav.
      if (picked.type === 'group' || (myEmail && email === myEmail.toLowerCase())) refreshMe();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleChangeRole(email: string, r: Role, type: PrincipalType = 'user') {
    setError(null);
    try {
      setSyncingKey(`${type}:${email}`);
      const res = await api.setRole(email, r, type);
      if (res.permissions) setPermResults({ title: `Access for ${email} (${r})`, results: res.permissions });
      await load();
      if (type === 'group' || (myEmail && email.toLowerCase() === myEmail.toLowerCase())) refreshMe();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingKey(null);
    }
  }

  async function handleRemove(email: string, type: PrincipalType = 'user') {
    setError(null);
    try {
      setSyncingKey(`${type}:${email}`);
      const res = await api.deleteRole(email, type);
      if (res.permissions) setPermResults({ title: `Access removed for ${email}`, results: res.permissions });
      await load();
      if (type === 'group' || (myEmail && email.toLowerCase() === myEmail.toLowerCase())) refreshMe();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingKey(null);
    }
  }

  // Non-admins never see this page's content (nav hides it, but guard anyway).
  if (!roleLoading && role !== 'admin') {
    return (
      <div className="w-full max-w-3xl mx-auto">
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Admins only</AlertTitle>
          <AlertDescription>You need the admin role to manage users.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-8 w-full">
      <PageHeader
        eyebrow="Manage"
        title="Admin"
        description="User roles, source catalog, target-schema configuration and AI settings."
      />

      <Tabs defaultValue="roles" className="space-y-8">
        <TabsList aria-label="Admin sections" className="gap-2 [&::-webkit-scrollbar]:hidden">
          {ADMIN_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="!px-3">{t.label}</TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="roles" className="space-y-6 mt-0">
      <SectionIntro title="Roles & permissions">
        Who can generate, review and administer mappings. Anyone without an explicit role is a Viewer.
      </SectionIntro>

      {/* Role legend */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {ROLES.map((r) => (
          <Panel key={r} className="px-5 py-4">
            <div className="flex items-center gap-2 mb-2">{roleBadge(r)}</div>
            <p className="text-[0.8125rem] leading-snug text-muted-foreground">{ROLE_DESC[r]}</p>
          </Panel>
        ))}
      </div>

      {error && (
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Assign a role */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Assign a role</CardTitle>
          <CardDescription>Grant a workspace user or group Editor or Admin. Group members inherit the group&apos;s role; anyone not covered is a Viewer by default.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-1 flex-1 min-w-64">
              <Label>User or group</Label>
              <PrincipalPicker value={picked} onChange={setPicked} principals={principals} loading={principalsLoading} />
            </div>
            <div className="space-y-1 w-40">
              <Label>Role</Label>
              <SearchableSelect
                value={newRole}
                onValueChange={(v) => setNewRole(v as Role)}
                className="w-full"
                options={ROLES.map((r) => ({ value: r, label: r }))}
              />
            </div>
            <Button onClick={() => void handleAssign()} disabled={saving}>
              <UserPlus className="h-4 w-4 mr-1.5" /> {saving ? 'Saving…' : 'Assign'}
            </Button>
          </div>
          {principals?.error && (
            <p className="text-xs text-muted-foreground mt-3">
              Couldn&apos;t load the workspace directory, so you can type a user&apos;s email instead. ({principals.error})
            </p>
          )}
          {msg && <p className="text-sm text-muted-foreground mt-3">{msg}</p>}
        </CardContent>
      </Card>

      {permResults && (
        <PermissionResults title={permResults.title} results={permResults.results} onDismiss={() => setPermResults(null)} />
      )}

      {/* Bootstrap admins (from env) */}
      {bootstrap.length > 0 && (
        <Panel tone="sunken" className="flex items-start gap-3 px-5 py-4">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
          <div className="text-sm">
            <p className="font-semibold">Bootstrap admins (environment)</p>
            <p className="mt-0.5 text-muted-foreground">
              These emails are always admins via <Code>AIMAPPER_ADMINS</Code> and cannot be changed here:{' '}
              <span className="font-medium text-foreground">{bootstrap.join(', ')}</span>.
            </p>
          </div>
        </Panel>
      )}

      {/* Assignments table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Assigned roles</CardTitle>
          <CardDescription>Users and groups with an explicit role. Assigning a role also grants the access it needs on the app&apos;s resources (app, warehouse, Genie, Knowledge Assistant, Vector Search, Unity Catalog), using your credentials. A user&apos;s effective role is the highest of their own and their groups&apos;. Removing an assignment revokes only access granted here.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading && <div className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>}
          {!loading && rows.length === 0 && <p className="text-sm text-muted-foreground">No explicit assignments yet — everyone is a Viewer.</p>}
          {!loading && rows.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User / group</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Updated by</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const type: PrincipalType = r.principal_type === 'group' ? 'group' : 'user';
                  return (
                  <TableRow key={`${type}:${r.user_email}`}>
                    <TableCell className="text-sm font-medium">
                      <span className="inline-flex items-center gap-3">
                        {type === 'group' ? (
                          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><Users className="h-3.5 w-3.5" /></span>
                        ) : (
                          <Avatar name={r.user_email} size="sm" />
                        )}
                        {r.user_email}
                        {type === 'group' && <Tag>Group</Tag>}
                      </span>
                      {type === 'user' && myEmail && r.user_email.toLowerCase() === myEmail.toLowerCase() && (
                        <span className="text-xs text-muted-foreground ml-2">(you)</span>
                      )}
                    </TableCell>
                    <TableCell className="w-36">
                      <SearchableSelect
                        value={String(r.role).toLowerCase()}
                        onValueChange={(v) => void handleChangeRole(r.user_email, v as Role, type)}
                        className="w-full h-8"
                        options={ROLES.map((x) => ({ value: x, label: x }))}
                      />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.updated_by ?? '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.updated_at ? String(r.updated_at).slice(0, 16) : '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="icon-sm"
                        className="mr-1.5"
                        disabled={syncingKey === `${type}:${r.user_email}`}
                        onClick={() => void handleChangeRole(r.user_email, String(r.role).toLowerCase() as Role, type)}
                        title="Re-sync access: re-apply this role's resource permissions"
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                        <span className="sr-only">Re-sync access</span>
                      </Button>
                      <Button variant="outline" size="icon-sm" onClick={() => void handleRemove(r.user_email, type)} title="Remove assignment (revert to Viewer)">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
        </TabsContent>

        <TabsContent value="config" className="mt-0">
          <ConfigPanel />
        </TabsContent>

        <TabsContent value="ka" className="mt-0 space-y-6">
          <SectionIntro title="Knowledge Assistant">
            Reference documents that ground attribute discovery and SQL generation.
          </SectionIntro>
          <KnowledgeAssistantPanel />
        </TabsContent>

        <TabsContent value="sourceSystems" className="mt-0">
          <SourceSystemsPanel />
        </TabsContent>

        <TabsContent value="vendors" className="mt-0">
          <VendorsPanel />
        </TabsContent>

        <TabsContent value="retrieval" className="mt-0">
          <RetrievalPanel />
        </TabsContent>

        <TabsContent value="promptSizing" className="mt-0 space-y-6">
          <PromptSizingPanel />
          <ModelSelectionPanel />
        </TabsContent>

        <TabsContent value="usage" className="mt-0">
          <UsagePanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
