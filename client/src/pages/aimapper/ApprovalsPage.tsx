import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Skeleton,
  Button,
  Alert,
  AlertTitle,
  AlertDescription,
} from '@databricks/appkit-ui/react';
import { Eye, Inbox, ChevronsUpDown, ChevronUp, ChevronDown, Loader2 } from 'lucide-react';
import { api, type HistoryRow, type ApprovalAction, type AttributeMapping } from '../../lib/aimapperApi';
import type { ReloadPayload } from './MapperPage';
import { useRole } from '../../lib/roleContext';
import { approvalBadge, ApprovalActions } from './approvalUi';
import { PageHeader, Panel, StatCard, SearchField, EmptyState, Mono, Tag, Avatar } from '../../components/studio';
import { splitDateTime, type Tone } from '../../lib/display';

const TONE_BY_TAB: Record<string, Tone> = { in_review: 'warning', approved: 'success', rejected: 'danger' };

// The queue is organised by lifecycle stage. Default to "in_review" — the
// reviewer's inbox — but allow browsing the other stages too.
const TABS: { key: string; label: string }[] = [
  { key: 'in_review', label: 'In Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

// Sortable columns and how to extract a comparable value from a row.
type SortKey = 'created_at' | 'project' | 'source_system' | 'source' | 'target_table' | 'version' | 'created_by';
function sortValue(r: HistoryRow, key: SortKey): string | number {
  switch (key) {
    case 'created_at': return String(r.created_at ?? '');
    case 'project': return (r.project_name ?? '').toLowerCase();
    case 'source_system': return (r.source_system ?? 'Epic').toLowerCase();
    case 'source': return `${r.source_schema ?? ''}.${r.source_table ?? ''}`.toLowerCase();
    case 'target_table': return (r.target_table ?? '').toLowerCase();
    case 'version': return r.version ?? -1;
    case 'created_by': return (r.created_by ?? '').toLowerCase();
  }
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

export function ApprovalsPage() {
  const { isEditor } = useRole();
  const navigate = useNavigate();
  const [tab, setTab] = useState('in_review');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transitioningId, setTransitioningId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  // Column sort. Default: newest submitted first.
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Sensible default direction per column: dates/version newest-first, text A→Z.
      setSortDir(key === 'created_at' || key === 'version' ? 'desc' : 'asc');
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch the active tab's rows plus counts for every tab (cheap: LIMIT 500 each,
      // but we only need lengths, so pull all-at-once in parallel).
      const [active, ...all] = await Promise.all([
        api.history('', tab),
        ...TABS.map((t) => api.history('', t.key)),
      ]);
      setRows(active.rows);
      const c: Record<string, number> = {};
      TABS.forEach((t, i) => { c[t.key] = all[i].rows.length; });
      setCounts(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { void load(); }, [load]);

  async function handleTransition(itemId: string, action: ApprovalAction) {
    setTransitioningId(itemId);
    setError(null);
    try {
      await api.approvalTransition(itemId, action);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTransitioningId(null);
    }
  }

  async function handleLoad(itemId: string) {
    setLoadingId(itemId);
    setError(null);
    try {
      const { item } = await api.historyDetail(itemId);
      if (!item || !item.target_table) { setError('This item has no reloadable target.'); return; }
      let mappings: AttributeMapping[] = [];
      try { mappings = JSON.parse(item.mappings_json ?? '[]') as AttributeMapping[]; } catch { mappings = []; }
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

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matched = !needle
      ? rows
      : rows.filter((r) =>
          [r.source_schema, r.source_table, r.target_table, r.created_by, r.source_system, r.project_name]
            .some((v) => String(v ?? '').toLowerCase().includes(needle)),
        );
    // Sort a copy so the source rows stay in their fetched order.
    const sorted = [...matched].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      let cmp: number;
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [rows, q, sortKey, sortDir]);

  // Sortable header button (shared by every sortable column).
  const sortBtn = (key: SortKey, label: string) => {
    const active = sortKey === key;
    return (
      <button
        key={key}
        type="button"
        onClick={() => toggleSort(key)}
        className={`inline-flex items-center gap-1 -ml-1 px-1 py-0.5 rounded uppercase tracking-[0.06em] hover:bg-muted transition-colors ${active ? 'text-foreground' : ''}`}
        title={`Sort by ${label}`}
      >
        {label}
        {active
          ? (sortDir === 'asc' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />)
          : <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />}
      </button>
    );
  };

  const activeLabel = TABS.find((t) => t.key === tab)?.label;

  return (
    <div className="space-y-6 w-full">
      <PageHeader
        eyebrow="Workspace"
        title="Approval queue"
        description={isEditor
          ? 'Review mappings submitted for approval. Approve, reject, or reopen. Only approved mappings feed the learning loop.'
          : 'Track the status of mappings submitted for review. Editors approve or reject them.'}
      />

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Stage switcher: one tile per lifecycle stage (selected tile renders in ink). */}
      <div role="tablist" aria-label="Approval stage" className="grid gap-4 sm:grid-cols-3">
        {TABS.map((t) => (
          <StatCard
            key={t.key}
            label={t.key === 'in_review' ? 'In review' : t.label}
            value={counts[t.key] ?? 0}
            dot={TONE_BY_TAB[t.key]}
            active={tab === t.key}
            onClick={() => setTab(t.key)}
          />
        ))}
      </div>

      <Panel className="overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-4 px-6 pt-5 pb-4">
          <div>
            <h2 className="text-[1.125rem] font-bold tracking-tight">{tab === 'in_review' ? 'In review' : activeLabel}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {tab === 'in_review'
                ? 'Mappings waiting for an editor’s decision.'
                : `Mappings that were ${tab}.`}
            </p>
          </div>
          <SearchField value={q} onChange={setQ} placeholder="Filter source, target, user…" ariaLabel="Search" className="w-full sm:w-80" />
        </div>
        {loading && <div className="space-y-2 px-6 pb-6"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>}
        {!loading && filtered.length === 0 && (
          <div className="px-6 pb-6">
            <EmptyState icon={<Inbox className="h-7 w-7 opacity-60" />}>
              {q ? `Nothing matches “${q}”.` : `Nothing ${activeLabel?.toLowerCase()}.`}
            </EmptyState>
          </div>
        )}
        {!loading && filtered.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">{sortBtn('created_at', 'Submitted')}</TableHead>
                <TableHead><span className="inline-flex items-center gap-2">{sortBtn('target_table', 'Target')}{sortBtn('version', 'Ver')}</span></TableHead>
                <TableHead>{sortBtn('source', 'Source')}</TableHead>
                <TableHead><span className="inline-flex items-center gap-2">{sortBtn('project', 'Project')}{sortBtn('source_system', 'System')}</span></TableHead>
                <TableHead>{sortBtn('created_by', 'By')}</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right pr-6">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => {
                const when = splitDateTime(r.created_at);
                return (
                  <TableRow key={r.item_id}>
                    <TableCell className="pl-6 py-4">
                      <div className="font-semibold text-sm">{when.date}</div>
                      <div className="text-xs text-muted-foreground">{when.time}</div>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-2">
                        <Mono className="font-semibold">{r.target_table ?? '—'}</Mono>
                        <Tag>{r.version != null ? `v${r.version}` : '—'}</Tag>
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[16rem]"><SourceTables schema={r.source_schema} tables={r.source_table} /></TableCell>
                    <TableCell className="max-w-[12rem]">
                      <div className="text-sm truncate" title={r.project_name ?? undefined}>{r.project_name ?? '—'}</div>
                      <div className="text-xs text-muted-foreground">{r.source_system ?? 'Epic'}</div>
                    </TableCell>
                    <TableCell>
                      {r.created_by
                        ? (
                          <span className="inline-flex items-center gap-2" title={r.created_by}>
                            <Avatar name={r.created_by} size="sm" />
                            <span className="text-xs text-muted-foreground max-w-[7rem] truncate">{r.created_by.split('@')[0]}</span>
                          </span>
                        )
                        : <span className="text-xs text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>{approvalBadge(r.approval_status)}</TableCell>
                    <TableCell className="pr-6">
                      <div className="flex items-center justify-end gap-2">
                        <ApprovalActions
                          appr={(r.approval_status ?? 'in_review').toLowerCase()}
                          isEditor={isEditor}
                          busy={transitioningId === r.item_id}
                          reviewedBy={r.reviewed_by}
                          onTransition={(action) => void handleTransition(r.item_id, action)}
                          showReviewer={false}
                        />
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-9 w-9"
                          onClick={() => void handleLoad(r.item_id)}
                          disabled={!r.target_table || loadingId === r.item_id}
                          title={loadingId === r.item_id ? 'Opening…' : 'Inspect — open this mapping in the Mapper to view the SQL (does not change its status)'}
                        >
                          {loadingId === r.item_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                          <span className="sr-only">Inspect</span>
                        </Button>
                      </div>
                    </TableCell>
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
