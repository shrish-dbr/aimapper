import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Skeleton,
  Button,
} from '@databricks/appkit-ui/react';
import { History as HistoryIcon, Trash2, ChevronDown, ChevronRight, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { api, type HistoryRow, type HistoryItemDetail, type AttributeMapping, type ApprovalAction } from '../../lib/aimapperApi';
import type { ReloadPayload } from './MapperPage';
import { useRole } from '../../lib/roleContext';
import { ApprovalActions } from './approvalUi';
import { useSort, type SortDir } from '../../lib/useSort';
import { PageHeader, Panel, StatusPill, Mono, Tag, Meter, SearchField, EmptyState } from '../../components/studio';
import { splitDateTime, statusTone, statusLabel } from '../../lib/display';

// Module-level cache so navigating back to History renders the last rows instantly,
// then revalidates in the background. Survives route changes; resets on full reload.
let rowsCache: HistoryRow[] | null = null;

// Comparable value per sortable column.
function historySortValue(r: HistoryRow, key: string): string | number {
  switch (key) {
    case 'created_at': return String(r.created_at ?? '');
    case 'project': return (r.project_name ?? '').toLowerCase();
    case 'source_system': return (r.source_system ?? '').toLowerCase();
    case 'source': return `${r.source_schema ?? ''}.${r.source_table ?? ''}`.toLowerCase();
    case 'target': return (r.target_table ?? '').toLowerCase();
    case 'version': return r.version ?? -1;
    case 'match': return (r.match_method ?? '').toLowerCase();
    case 'status': return (r.status ?? '').toLowerCase();
    default: return '';
  }
}

function statusBadge(s: string) {
  return <StatusPill tone={statusTone(s)} title={s}>{statusLabel(s)}</StatusPill>;
}

/** Header sort button (lets two sort keys share one visual column). */
function SortBtn({ label, k, sortKey, dir, onSort }: { label: string; k: string; sortKey: string; dir: SortDir; onSort: (key: string) => void }) {
  const active = sortKey === k;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      title={`Sort by ${label}`}
      className={`inline-flex items-center gap-1 -ml-1 px-1 py-0.5 rounded uppercase tracking-[0.06em] hover:bg-muted hover:text-foreground transition-colors ${active ? 'text-foreground' : ''}`}
    >
      {label}
      {active
        ? (dir === 'asc' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />)
        : <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />}
    </button>
  );
}

/** Source tables stacked one per line (mono), with the schema as a muted caption. */
function SourceTables({ schema, tables }: { schema: string | null | undefined; tables: string | null | undefined }) {
  const list = String(tables ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return (
    <div className="min-w-0" title={`${schema ?? ''}.${tables ?? ''}`}>
      {list.length === 0 ? <Mono className="text-muted-foreground">—</Mono> : list.map((t) => (
        <Mono key={t} className="block truncate leading-5">{t}</Mono>
      ))}
      {schema && <div className="text-[0.6875rem] text-muted-foreground truncate mt-0.5">{schema}</div>}
    </div>
  );
}

export function HistoryPage() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<HistoryRow[]>(() => rowsCache ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [transitioningId, setTransitioningId] = useState<string | null>(null);
  const navigate = useNavigate();
  const { isEditor, isAdmin } = useRole();

  const load = useCallback(async () => {
    if (rowsCache) setRows(rowsCache);
    else setLoading(true);
    setError(null);
    try {
      // History shows only APPROVED mappings; the approval lifecycle lives on Approvals.
      const fresh = (await api.history('', 'approved')).rows;
      rowsCache = fresh;
      setRows(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDelete(itemId: string) {
    try {
      await api.deleteHistoryItem(itemId);
      setConfirmDelete(null);
      if (expanded === itemId) setExpanded(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Feature 1 — fetch the full saved item and reload it into the Mapper.
  async function handleLoad(itemId: string) {
    setLoadingId(itemId);
    setError(null);
    try {
      const { item } = await api.historyDetail(itemId);
      if (!item || !item.target_table) {
        setError('This run has no reloadable target.');
        return;
      }
      let mappings: AttributeMapping[] = [];
      try {
        mappings = JSON.parse(item.mappings_json ?? '[]') as AttributeMapping[];
      } catch { mappings = []; }
      if (mappings.length === 0) {
        setError('This run predates mapping capture — only its SQL is available. Re-run to enable full reload.');
      }
      const reload: ReloadPayload = {
        catalog: item.source_catalog,
        schema: item.source_schema,
        targetTable: item.target_table,
        mappings,
        sql: item.generated_sql,
        version: item.version,
        sourceSystem: item.source_system,
        projectId: item.project_id,
      };
      void navigate('/mapper', { state: { reload } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingId(null);
    }
  }

  async function handleTransition(itemId: string, action: ApprovalAction) {
    setTransitioningId(itemId);
    setError(null);
    try {
      await api.approvalTransition(itemId, action);
      // Cache is refreshed by load().
      rowsCache = null;
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTransitioningId(null);
    }
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) =>
      [r.source_schema, r.source_table, r.target_table, r.endpoint_name, r.match_method, r.created_by, r.source_system, r.project_name]
        .some((v) => String(v ?? '').toLowerCase().includes(needle)),
    );
  }, [rows, q]);

  const { sorted, sortKey, sortDir, toggle } = useSort(filtered, historySortValue, 'created_at', 'desc');

  const sb = (label: string, k: string) => <SortBtn label={label} k={k} sortKey={sortKey} dir={sortDir} onSort={toggle} />;

  return (
    <div className="space-y-6 w-full">
      <PageHeader
        eyebrow="Workspace"
        title="Mapping history"
        description={
          <>
            Approved source-to-target mappings. Expand to inspect the generated SQL. Mappings awaiting review stay on{' '}
            <Link to="/approvals" className="font-medium text-brand-strong underline underline-offset-2 hover:text-brand">Approvals</Link> until approved.
          </>
        }
        actions={<p className="text-sm text-muted-foreground">Showing the most recent 500 approved items</p>}
      />

      <Panel className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-6 pt-5 pb-4">
          <SearchField value={q} onChange={setQ} placeholder="Filter source, target, endpoint…" ariaLabel="Search" className="w-full sm:w-96" />
        </div>
        {loading && <div className="space-y-2 px-6 pb-6"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>}
        {error && <p className="px-6 pb-5 text-sm text-destructive">{error}</p>}
        {!loading && !error && rows.length === 0 && (
          <div className="px-6 pb-6">
            <EmptyState icon={<HistoryIcon className="h-7 w-7 opacity-60" />}>No approved mappings yet. Approve items on the Approvals page to see them here.</EmptyState>
          </div>
        )}
        {!loading && !error && rows.length > 0 && filtered.length === 0 && (
          <p className="px-6 pb-5 text-sm text-muted-foreground">No runs match “{q}”.</p>
        )}
        {filtered.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">{sb('Approved', 'created_at')}</TableHead>
                <TableHead><span className="inline-flex items-center gap-2">{sb('Target', 'target')}{sb('Ver', 'version')}</span></TableHead>
                <TableHead>{sb('Source tables', 'source')}</TableHead>
                <TableHead><span className="inline-flex items-center gap-2">{sb('Project', 'project')}{sb('System', 'source_system')}</span></TableHead>
                <TableHead>{sb('Match', 'match')}</TableHead>
                <TableHead>{sb('Status', 'status')}</TableHead>
                <TableHead className="text-right pr-4">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r) => (
                <FragmentRow
                  key={r.item_id}
                  r={r}
                  expanded={expanded === r.item_id}
                  confirming={confirmDelete === r.item_id}
                  onToggle={() => setExpanded(expanded === r.item_id ? null : r.item_id)}
                  onAskDelete={() => setConfirmDelete(r.item_id)}
                  onCancelDelete={() => setConfirmDelete(null)}
                  onConfirmDelete={() => void handleDelete(r.item_id)}
                  onLoad={() => void handleLoad(r.item_id)}
                  loadingRow={loadingId === r.item_id}
                  isEditor={isEditor}
                  isAdmin={isAdmin}
                  onTransition={(action) => void handleTransition(r.item_id, action)}
                  transitioning={transitioningId === r.item_id}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  );
}

function FragmentRow({
  r,
  expanded,
  confirming,
  onToggle,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
  onLoad,
  loadingRow,
  isEditor,
  isAdmin,
  onTransition,
  transitioning,
}: {
  r: HistoryRow;
  expanded: boolean;
  confirming: boolean;
  onToggle: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onLoad: () => void;
  loadingRow: boolean;
  isEditor: boolean;
  isAdmin: boolean;
  onTransition: (action: ApprovalAction) => void;
  transitioning: boolean;
}) {
  const reloadable = Boolean(r.target_table);
  const appr = (r.approval_status ?? 'in_review').toLowerCase();
  const when = splitDateTime(r.created_at);
  const conf = r.match_confidence != null ? Number(r.match_confidence) : null;
  return (
    <>
      <TableRow className="[&>td]:py-4">
        <TableCell className="pl-6 align-top">
          <div className="font-semibold text-sm whitespace-nowrap">{when.date}</div>
          <div className="text-xs text-muted-foreground">{when.time}</div>
        </TableCell>
        <TableCell className="align-top max-w-[13rem]">
          <span className="inline-flex items-center gap-2 min-w-0">
            <Mono className="font-semibold truncate" title={r.target_table ?? undefined}>{r.target_table ?? '—'}</Mono>
            <Tag>{r.version != null ? `v${r.version}` : '—'}</Tag>
          </span>
        </TableCell>
        <TableCell className="align-top max-w-[13rem]">
          <SourceTables schema={r.source_schema} tables={r.source_table} />
        </TableCell>
        <TableCell className="align-top max-w-[11rem]">
          <div className="text-sm truncate" title={r.project_name ?? undefined}>{r.project_name ?? '—'}</div>
          <div className="text-xs text-muted-foreground">{r.source_system ?? 'Epic'}</div>
        </TableCell>
        <TableCell className="align-top min-w-[7rem] max-w-[9rem]">
          {conf != null ? (
            <div className="flex items-center gap-3">
              <Meter value={conf} className="flex-1" />
              <span className="text-sm font-bold tabular-nums">{Math.round(conf * 100)}%</span>
            </div>
          ) : null}
          <div className="mt-1.5 text-xs text-muted-foreground truncate" title={r.match_method}>{r.match_method}</div>
        </TableCell>
        <TableCell className="align-top">{statusBadge(r.status)}</TableCell>
        <TableCell className="align-top pr-4">
          <div className="flex items-center justify-end gap-1 flex-nowrap whitespace-nowrap">
            <ApprovalActions
              appr={appr}
              isEditor={isEditor}
              busy={transitioning}
              reviewedBy={r.reviewed_by}
              onTransition={onTransition}
              showReviewer={false}
            />
            <Button size="sm" className="h-9 px-3 bg-ink text-ink-foreground hover:bg-ink/90" onClick={onLoad} disabled={!reloadable || loadingRow} title="Open this mapping in the Mapper to inspect it (does not change its status)">
              {loadingRow ? 'Opening…' : 'Inspect'}
            </Button>
            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={onToggle} title={expanded ? 'Hide details' : 'Show details'}>
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              <span className="sr-only">{expanded ? 'Hide' : 'Details'}</span>
            </Button>
            {!isAdmin ? null : confirming ? (
              <span className="flex items-center gap-1.5">
                <Button variant="destructive" size="sm" className="h-9" onClick={onConfirmDelete}>Yes</Button>
                <Button variant="ghost" size="sm" className="h-9" onClick={onCancelDelete}>No</Button>
              </span>
            ) : (
              <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-destructive hover:bg-destructive/10" onClick={onAskDelete} title="Delete (admin)"><Trash2 className="h-4 w-4" /></Button>
            )}
          </div>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={7} className="bg-surface-sunken px-6 py-4">
            <RunItemDetail runId={r.run_id} sourceTable={r.source_table} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}


function RunItemDetail({ runId, sourceTable }: { runId: string; sourceTable: string }) {
  const [detail, setDetail] = useState<HistoryItemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const params = useMemo(() => ({ runId, sourceTable }), [runId, sourceTable]);

  useEffect(() => {
    let active = true;
    const fetchDetail = async () => {
      setLoading(true);
      try {
        const res = await api.historyItem(params.runId, params.sourceTable);
        if (active) setDetail(res.item);
      } catch {
        if (active) setDetail(null);
      } finally {
        if (active) setLoading(false);
      }
    };
    void fetchDetail();
    return () => {
      active = false;
    };
  }, [params]);

  if (loading) return <Skeleton className="h-24 w-full" />;
  if (!detail) return <p className="text-sm text-muted-foreground">No detail found for this row.</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm flex-wrap">
        <Mono className="font-semibold">{detail.source_table}</Mono>
        <span className="text-muted-foreground">→</span>
        <Mono className="font-semibold">{detail.target_table ?? '—'}</Mono>
        {statusBadge(detail.status)}
        {detail.match_method && <span className="text-xs text-muted-foreground">· {detail.match_method}</span>}
      </div>
      {detail.match_rationale && <p className="text-xs text-muted-foreground">{detail.match_rationale}</p>}
      {detail.generated_sql && (
        <pre className="code-surface p-4 text-xs leading-relaxed overflow-auto whitespace-pre-wrap thin-scroll max-h-96">{detail.generated_sql}</pre>
      )}
      {detail.error_message && <p className="text-xs text-destructive">{detail.error_message}</p>}
    </div>
  );
}
