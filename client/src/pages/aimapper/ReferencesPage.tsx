import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Button,
  Input,
  Label,
  Textarea,
  Skeleton,
  formatFileSize,
} from '@databricks/appkit-ui/react';
import { SearchableSelect } from './SearchableSelect';
import {
  Plus,
  ChevronRight,
  ChevronDown,
  FileText,
  Upload,
  RefreshCw,
  Save,
  Info,
} from 'lucide-react';
import { api, type MappingExample, type ReferenceDoc, type ReferenceDocsStatus } from '../../lib/aimapperApi';
import { useRole } from '../../lib/roleContext';
import { PageHeader, Panel, PanelHeader, StatusPill, Chip, Mono, SearchField, EmptyState, Tag } from '../../components/studio';
import { cn } from '../../lib/utils';

function isApproved(v: MappingExample['approved']): boolean {
  return String(v).toLowerCase() === 'true';
}

// Module-level caches so navigating back to References renders instantly, then
// revalidates in the background. Survive route changes; reset on page reload.
let examplesCache: MappingExample[] | null = null;
let targetsCache: string[] | null = null;

/** Format an ISO/epoch timestamp as a short local date-time, or "never". */
function fmtWhen(v: string | number | null | undefined): string {
  if (v == null || v === '') return 'never';
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

// ── Local presentational helpers ────────────────────────────────────────────

const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'ON', 'AS', 'WITH', 'AND', 'OR',
  'NOT', 'NULL', 'IS', 'IN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'GROUP', 'BY', 'ORDER', 'HAVING', 'UNION', 'ALL',
  'DISTINCT', 'OVER', 'PARTITION', 'DESC', 'ASC', 'LIMIT', 'CAST', 'TRY_CAST', 'COALESCE', 'UNPIVOT', 'PIVOT', 'FOR',
  'QUALIFY', 'EXISTS', 'BETWEEN', 'LIKE', 'TRUE', 'FALSE', 'INTERVAL', 'DATE', 'STRING', 'INT', 'DECIMAL', 'BIGINT',
  'DOUBLE', 'BOOLEAN', 'TIMESTAMP',
]);

/** Lightweight SQL highlighter for the dark code surface: comments, strings, keywords. */
function highlightSql(sql: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\/\*[\s\S]*?\*\/|--[^\n]*)|('(?:[^']|'')*')|\b([A-Za-z_]+)\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(sql)) !== null) {
    if (m.index > last) out.push(sql.slice(last, m.index));
    if (m[1]) out.push(<span key={i++} className="text-ink-muted">{m[1]}</span>);
    else if (m[2]) out.push(<span key={i++} className="text-[#f5c97a]">{m[2]}</span>);
    else if (m[3] && SQL_KEYWORDS.has(m[3].toUpperCase())) out.push(<span key={i++} className="text-[#ff8a78]">{m[3]}</span>);
    else out.push(m[0]);
    last = re.lastIndex;
  }
  if (last < sql.length) out.push(sql.slice(last));
  return out;
}

/** Dark code block used for example SQL. */
function SqlBlock({ sql }: { sql: string }) {
  return (
    <pre className="code-surface thin-scroll p-5 text-[0.8125rem] leading-relaxed overflow-auto whitespace-pre max-h-80">
      {highlightSql(sql)}
    </pre>
  );
}

/** Vector Search index state of the reference documents. */
function docsIndexState(st: ReferenceDocsStatus | null, syncing = false): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } | null {
  if (!st?.configured || !st.index) return null;
  if (syncing || st.index.running) return { label: 'Indexing…', tone: 'warning' };
  if (st.index.lastError) return { label: 'Index error', tone: 'danger' };
  return st.index.chunks > 0 ? { label: 'Indexed', tone: 'success' } : { label: 'Not indexed', tone: 'neutral' };
}

/** Underlined text action (Edit / Download / Delete) — keyboard accessible. */
function TextAction({ children, onActivate, tone = 'default' }: { children: ReactNode; onActivate: () => void; tone?: 'default' | 'danger' }) {
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); onActivate(); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onActivate(); } }}
      className={cn(
        'shrink-0 cursor-pointer text-sm font-semibold underline underline-offset-4 decoration-1',
        tone === 'danger' ? 'text-brand-soft-foreground hover:text-brand' : 'text-foreground hover:text-brand',
      )}
    >
      {children}
    </span>
  );
}

/** Small "label: value" row inside rail cards. */
function RailRow({ label, value, ink = false }: { label: ReactNode; value: ReactNode; ink?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className={ink ? 'text-ink-muted' : 'text-muted-foreground'}>{label}</span>
      <span className={cn('font-semibold text-right', ink ? 'text-ink-foreground' : 'text-foreground')}>{value}</span>
    </div>
  );
}

/** Inline feedback messages (info / error). */
function Notice({ tone, children }: { tone: 'info' | 'error'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-xl px-4 py-3 text-sm',
        tone === 'error' ? 'bg-danger-soft text-danger-soft-foreground' : 'bg-surface-sunken text-muted-foreground',
      )}
    >
      <Info className="h-4 w-4 mt-0.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

// Last-loaded instructions (per source system) so the Examples rail can show a
// summary of guidance already fetched on the Instructions tab — no extra calls.
let instructionsCache: { domain: string; text: string; updatedAt: string | null } | null = null;

function MappingExamplesTab({ actionSlot, onCount }: { actionSlot: HTMLElement | null; onCount: (n: number) => void }) {
  const { isEditor } = useRole();
  const [examples, setExamples] = useState<MappingExample[]>(examplesCache ?? []);
  const [targets, setTargets] = useState<string[]>(targetsCache ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fTarget, setFTarget] = useState('');
  const [fDomain, setFDomain] = useState('');
  const [fSig, setFSig] = useState('');
  const [fCols, setFCols] = useState('');
  const [fSql, setFSql] = useState('');
  const [fNotes, setFNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [domains, setDomains] = useState<string[]>([]);
  const [defaultDomain, setDefaultDomain] = useState('Epic');
  const [retrieval, setRetrieval] = useState<Awaited<ReturnType<typeof api.retrievalStatus>> | null>(null);
  const [resyncing, setResyncing] = useState(false);

  const load = useCallback(async () => {
    // Only skeleton on a cold load; otherwise revalidate over cached rows.
    if (examplesCache === null) setLoading(true);
    setError(null);
    try {
      const fresh = (await api.examples()).examples;
      examplesCache = fresh;
      setExamples(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshRetrieval = useCallback(() => {
    api.retrievalStatus().then(setRetrieval).catch(() => setRetrieval(null));
  }, []);

  useEffect(() => {
    void load();
    api.targetEntities().then((p) => {
      const names = p.targets.map((t) => t.target_table);
      targetsCache = names;
      setTargets(names);
    }).catch(() => {});
    api.sourceSystems().then((d) => {
      setDomains(d.sourceSystems);
      setDefaultDomain(d.defaultSourceSystem);
    }).catch(() => { setDomains(['Epic']); });
    refreshRetrieval();
  }, [load, refreshRetrieval]);

  // Rebuild the retrieval corpus from the curated examples (+ approved history) and
  // trigger the index to re-embed. Use after adding/editing examples so they become
  // retrievable during generation. Re-embedding takes a few minutes.
  async function handleResync() {
    setResyncing(true);
    setMsg(null);
    setError(null);
    try {
      const r = await api.rebuildRetrieval();
      setMsg(`Re-sync started: ${r.corpusRows} record(s) in the corpus. Re-embedding the index usually takes 2–5 minutes; the status above refreshes automatically.`);
      refreshRetrieval();
      // The index reports "Re-embedding" briefly, then "Ready" — poll a few times.
      let tries = 0;
      const poll = setInterval(() => {
        tries += 1;
        void (async () => {
          try {
            const st = await api.retrievalStatus();
            setRetrieval(st);
            if (st.indexReady === true || tries >= 10) clearInterval(poll);
          } catch { if (tries >= 10) clearInterval(poll); }
        })();
      }, 20000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResyncing(false);
    }
  }

  function resetForm() {
    setEditingId(null); setFTarget(''); setFDomain(''); setFSig(''); setFCols(''); setFSql(''); setFNotes('');
  }

  function startEdit(r: MappingExample) {
    setEditingId(r.example_id);
    setFTarget(r.target_table);
    setFDomain(r.source_system ?? defaultDomain);
    setFSig(r.source_signature ?? '');
    setFCols('');
    setFSql(r.generated_sql ?? '');
    setFNotes(r.notes ?? '');
    setShowForm(true);
    setMsg(null);
    // ensure the form is in view
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleSave() {
    if (!fTarget || !fSql.trim()) {
      setMsg('Target table and SQL are required.');
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const dom = fDomain || defaultDomain;
      if (editingId) {
        await api.updateExample({ exampleId: editingId, targetTable: fTarget, sourceSignature: fSig || undefined, sourceColumns: fCols || undefined, generatedSql: fSql.trim(), notes: fNotes || undefined, approved: true, sourceSystem: dom });
        setMsg(`Reference updated for ${fTarget}.`);
      } else {
        await api.saveExample({ targetTable: fTarget, sourceSignature: fSig || undefined, sourceColumns: fCols || undefined, generatedSql: fSql.trim(), notes: fNotes || undefined, approved: true, sourceSystem: dom });
        setMsg(`Example saved for ${fTarget}.`);
      }
      resetForm();
      setShowForm(false);
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(exampleId: string) {
    try {
      await api.deleteExample(exampleId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => { onCount(examples.length); }, [examples.length, onCount]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return examples;
    return examples.filter((r) =>
      [r.target_table, r.source_signature, r.notes, r.generated_sql, r.source_system]
        .some((v) => String(v ?? '').toLowerCase().includes(needle)),
    );
  }, [examples, q]);

  const addButton = isEditor ? (
    <Button size="lg" onClick={() => { if (showForm) { resetForm(); } else { setFDomain(defaultDomain); } setShowForm((s) => !s); }}>
      {showForm ? 'Cancel' : <><Plus className="h-4 w-4" /> Add an example</>}
    </Button>
  ) : null;

  const cachedInstructions = instructionsCache;
  const hasRail = !!retrieval?.configured || !!cachedInstructions;

  return (
    <>
      {actionSlot && addButton && createPortal(addButton, actionSlot)}
      <div className={cn('grid gap-6 items-start', hasRail && 'lg:grid-cols-[minmax(0,1fr)_23.5rem]')}>
        {/* ── Main column: search + collapsible example cards ─────────────── */}
        <div className="space-y-4 min-w-0">
          <p className="text-sm text-muted-foreground">
            Curated source-to-target SQL conversions used as references during generation. For each target table, the
            most column-similar approved references are injected into the LLM prompt to guide transformation patterns,
            casting style, and column conventions — without retraining the model. Add or edit curated references here, or
            use “⭐ Save as example” on a successful mapping.
          </p>

          {showForm && (
            <Panel>
              <PanelHeader
                title={editingId ? 'Edit reference' : 'New example'}
                description="Add or edit curated references, or use “⭐ Save as example” on a successful mapping."
              />
              <div className="space-y-4 border-t border-border px-6 py-5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Source System</Label>
                    <SearchableSelect
                      value={fDomain}
                      onValueChange={setFDomain}
                      className="w-full"
                      placeholder="Select source system"
                      options={domains.map((d) => ({ value: d, label: d }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Target Table</Label>
                    <SearchableSelect
                      value={fTarget}
                      onValueChange={setFTarget}
                      className="w-full"
                      placeholder="Select target"
                      options={targets.map((t) => ({ value: t, label: t }))}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Source Label</Label>
                  <Input value={fSig} onChange={(e) => setFSig(e.target.value)} placeholder="catalog.schema.table (optional)" />
                </div>
                <div className="space-y-1.5">
                  <Label>Source Columns</Label>
                  <Input value={fCols} onChange={(e) => setFCols(e.target.value)} placeholder="space/comma-separated column names (used for matching)" />
                </div>
                <div className="space-y-1.5">
                  <Label>Known-Good SQL</Label>
                  <Textarea value={fSql} onChange={(e) => setFSql(e.target.value)} placeholder="SELECT ... FROM ..." className="font-mono text-xs h-48" />
                </div>
                <div className="space-y-1.5">
                  <Label>Notes</Label>
                  <Input value={fNotes} onChange={(e) => setFNotes(e.target.value)} placeholder="Why this is a good pattern (optional)" />
                </div>
                <div className="flex justify-end">
                  <Button onClick={() => void handleSave()} disabled={saving}>{saving ? 'Saving…' : editingId ? 'Update Reference' : 'Save Example'}</Button>
                </div>
              </div>
            </Panel>
          )}

          {msg && <Notice tone="info">{msg}</Notice>}
          {error && <Notice tone="error">{error}</Notice>}

          {examples.length > 0 && (
            <SearchField value={q} onChange={setQ} placeholder="Search by target, source, notes, SQL…" />
          )}

          {loading && <Skeleton className="h-24 w-full rounded-[var(--radius)]" />}
          {!loading && examples.length === 0 && (
            <EmptyState>No examples yet. Add curated ones above, or use “⭐ Save as example” on a successful run.</EmptyState>
          )}
          {!loading && examples.length > 0 && filtered.length === 0 && (
            <EmptyState>No references match “{q}”.</EmptyState>
          )}

          <div className="space-y-3">
            {filtered.map((r) => {
              const isOpen = expanded.has(r.example_id);
              const approved = isApproved(r.approved);
              return (
                <Panel key={r.example_id} className="overflow-hidden">
                  {/* Header row — click to expand/collapse. */}
                  <button
                    type="button"
                    onClick={() => toggle(r.example_id)}
                    className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-surface-sunken/60 transition-colors"
                    aria-expanded={isOpen}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-input bg-card text-muted-foreground">
                      {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </span>
                    <Mono className="text-base font-semibold text-foreground">{r.target_table}</Mono>
                    <Chip>{r.source_system ?? 'Epic'}</Chip>
                    <StatusPill tone={approved ? 'success' : 'neutral'} dot={false}>
                      {approved ? 'Approved' : 'Unapproved'}
                    </StatusPill>
                    {!isOpen && r.source_signature && (
                      <Mono className="text-xs text-muted-foreground truncate min-w-0">{r.source_signature}</Mono>
                    )}
                    {isEditor && (
                      <span className="ml-auto flex items-center gap-4 pl-2 shrink-0">
                        <TextAction onActivate={() => startEdit(r)}>Edit</TextAction>
                        <TextAction tone="danger" onActivate={() => void handleDelete(r.example_id)}>Delete</TextAction>
                      </span>
                    )}
                  </button>
                  {isOpen && (
                    <div className="px-5 pb-5 space-y-3">
                      {r.source_signature && <Mono className="block text-xs text-muted-foreground break-all">{r.source_signature}</Mono>}
                      {r.notes && <p className="text-[0.9375rem] leading-relaxed text-foreground/90">{r.notes}</p>}
                      {r.generated_sql && <SqlBlock sql={r.generated_sql} />}
                    </div>
                  )}
                </Panel>
              );
            })}
          </div>
        </div>

        {/* ── Right rail ─────────────────────────────────────────────────── */}
        {hasRail && <aside className="space-y-4 min-w-0">
          {retrieval?.configured && (
            <Panel tone="ink" className="p-5 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-[1.0625rem] font-bold text-white">Example search</h3>
                {retrieval.indexReady === false ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-warning"><span className="h-1.5 w-1.5 rounded-full bg-current" />Re-embedding…</span>
                ) : retrieval.indexReady ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#5fd39d]"><span className="h-1.5 w-1.5 rounded-full bg-current" />Ready</span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-muted"><span className="h-1.5 w-1.5 rounded-full bg-current" />Unknown</span>
                )}
              </div>
              <p className="text-sm text-ink-foreground/85">
                The most column-similar approved references are retrieved by Vector Search for each target.
              </p>
              <RailRow ink label="Last rebuilt" value={fmtWhen(retrieval.lastRebuiltAt)} />
              {isEditor && (
                <button
                  type="button"
                  onClick={() => void handleResync()}
                  disabled={resyncing || retrieval.indexReady === false}
                  title="Rebuild the retrieval corpus from your examples and re-embed the index. Run this after adding or editing examples so they're used during generation."
                  className="flex w-full items-center justify-center gap-2 rounded-[0.625rem] border border-white/20 bg-transparent px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-50 disabled:pointer-events-none"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${resyncing ? 'animate-spin' : ''}`} />
                  {resyncing ? 'Re-syncing…' : 'Re-sync index'}
                </button>
              )}
            </Panel>
          )}

          {cachedInstructions && (
            <Panel className="p-5 space-y-3">
              <h3 className="text-[1.0625rem] font-bold">{cachedInstructions.domain} instructions</h3>
              {cachedInstructions.text ? (
                <p className="rounded-lg bg-surface-sunken px-4 py-3 text-sm text-foreground/90 line-clamp-4">“{cachedInstructions.text}”</p>
              ) : (
                <p className="text-sm text-muted-foreground">No instructions set for this source system.</p>
              )}
              <p className="text-xs text-muted-foreground">
                {cachedInstructions.text.length.toLocaleString()} / {MAX_INSTRUCTIONS.toLocaleString()} characters
                {cachedInstructions.updatedAt ? ` · updated ${fmtWhen(cachedInstructions.updatedAt)}` : ''}
              </p>
            </Panel>
          )}
        </aside>}
      </div>
    </>
  );
}

// Module-level caches (like examplesCache above) so the docs tab renders
// instantly on return, then revalidates.
let docsCache: ReferenceDoc[] | null = null;
let docsStatusCache: ReferenceDocsStatus | null = null;

function ReferenceDocsTab({ onCount }: { onCount: (n: number) => void }) {
  const { isEditor } = useRole();
  const [status, setStatus] = useState<ReferenceDocsStatus | null>(docsStatusCache);
  const [docs, setDocs] = useState<ReferenceDoc[]>(docsCache ?? []);
  const [domains, setDomains] = useState<string[]>([]);
  const [domain, setDomain] = useState('');
  const [loading, setLoading] = useState(docsCache === null);
  const [error, setError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Load the domain list once; default to the first (Epic).
  useEffect(() => {
    api.sourceSystems().then((d) => {
      setDomains(d.sourceSystems);
      setDomain((prev) => prev || d.defaultSourceSystem || d.sourceSystems[0] || 'Epic');
    }).catch(() => { setDomains(['Epic']); setDomain((p) => p || 'Epic'); });
  }, []);

  const load = useCallback(async (dom: string) => {
    if (!dom) return;
    setError(null);
    setNeedsReauth(false);
    try {
      const [st, list] = await Promise.all([api.referenceDocs.status(), api.referenceDocs.list(dom)]);
      docsStatusCache = st;
      setStatus(st);
      if (list.error) { setError(list.error); setNeedsReauth(!!list.needsReauth); }
      docsCache = list.files;
      setDocs(list.files);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      setError(m);
      setNeedsReauth(/re-?authorize|required scopes?/i.test(m));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (domain) void load(domain);
  }, [domain, load]);

  function showError(err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    setError(m);
    setNeedsReauth(/re-?authorize|required scopes?/i.test(m));
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setMsg(null);
    setError(null);
    setNeedsReauth(false);
    try {
      for (const file of Array.from(files)) {
        await api.referenceDocs.upload(file, domain);
      }
      setMsg(
        status?.index
          ? `Uploaded ${files.length} file(s) to ${domain}. They're being parsed and indexed in the background (about a minute per document).`
          : `Uploaded ${files.length} file(s) to ${domain}. They'll be indexed once reference grounding is configured.`,
      );
      await load(domain);
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function handleDelete(name: string) {
    setBusy(true);
    setError(null);
    setNeedsReauth(false);
    try {
      await api.referenceDocs.remove(name, domain);
      await load(domain);
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleDownload(name: string) {
    setError(null);
    setNeedsReauth(false);
    try {
      await api.referenceDocs.download(name, domain);
    } catch (err) {
      showError(err);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setMsg(null);
    setError(null);
    setNeedsReauth(false);
    try {
      await api.referenceDocs.sync();
      setMsg('Re-index started — new or changed documents are parsed and indexed (usually 1–5 minutes). You can keep working; this refreshes automatically.');
      // Poll until the background re-index finishes (keep the icon spinning).
      // Give up after ~10 min so the spinner never hangs forever.
      const deadline = Date.now() + 10 * 60 * 1000;
      // Small initial delay before the first poll.
      await new Promise((r) => setTimeout(r, 4000));
      while (Date.now() < deadline) {
        let st: ReferenceDocsStatus | null = null;
        try { st = await api.referenceDocs.status(); } catch { /* transient */ }
        if (st) { docsStatusCache = st; setStatus(st); }
        if (st && (!st.index || !st.index.running)) {
          setMsg(st.index?.lastError ? `Re-index finished with an error: ${st.index.lastError}` : 'Re-index complete — reference documents are indexed.');
          break;
        }
        await new Promise((r) => setTimeout(r, 15000));
      }
      await load(domain);
    } catch (err) {
      showError(err);
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => { if (!loading) onCount(docs.length); }, [docs.length, loading, onCount]);

  // Not configured: explain how to enable it, but still allow uploading files to
  // the volume (they'll be indexed once an admin configures the reference index).
  const notConfigured = status != null && !status.configured;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_23.5rem] items-start">
      <div className="space-y-4 min-w-0">
        <p className="text-sm text-muted-foreground">
          Upload reference documents (data dictionaries, field definitions, mapping runbooks) that describe your source
          metadata. They are split into passages and indexed with Vector Search; the most relevant passages{' '}
          <strong className="text-foreground">ground</strong> attribute discovery and SQL generation — they are injected
          into the prompts, with file and page citations, alongside the mapping examples.
        </p>

        <div className="flex items-end gap-4 flex-wrap">
          <div className="space-y-1.5 w-56">
            <Label>Source system</Label>
            <SearchableSelect
              value={domain}
              onValueChange={setDomain}
              disabled={!domains.length}
              className="w-full"
              placeholder="Select source system"
              options={domains.map((d) => ({ value: d, label: d }))}
            />
          </div>
          <p className="text-xs text-muted-foreground pb-2 flex-1 min-w-64">
            Documents are organized per source system. Mappings are grounded only in passages from their project&apos;s source-system documents.
          </p>
        </div>

        {notConfigured && (
          <div className="rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning-soft-foreground">
            Reference grounding isn&apos;t configured yet, so uploaded documents are not used to ground mappings. An admin can
            enable it by running <code className="font-mono">setup/create_reference_index.sh</code> and setting{' '}
            <code className="font-mono">AIMAPPER_DOCS_INDEX</code>. You can still upload files to the volume below.
          </div>
        )}

        {msg && <Notice tone="info">{msg}</Notice>}
        {error && needsReauth && (
          <div className="rounded-xl bg-warning-soft p-4 flex items-start gap-3">
            <RefreshCw className="h-4 w-4 text-warning-soft-foreground mt-0.5 shrink-0" />
            <div className="flex-1 text-sm text-warning-soft-foreground">
              <p className="font-semibold">Re-authorization needed</p>
              <p className="mt-0.5">{error}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>Reload</Button>
          </div>
        )}
        {error && !needsReauth && <Notice tone="error">{error}</Notice>}

        <Panel className="overflow-hidden">
          <PanelHeader
            title="Reference documents"
            description={loading ? 'Loading…' : `${docs.length} document(s) in the reference library.`}
          />
          <div className="border-t border-border">
            {loading && <div className="p-5"><Skeleton className="h-16 w-full" /></div>}
            {!loading && docs.length === 0 && (
              <div className="p-5">
                <EmptyState icon={<FileText className="h-5 w-5" />}>No reference documents yet.{isEditor ? ' Upload some on the right.' : ''}</EmptyState>
              </div>
            )}
            <ul className="divide-y divide-border">
              {docs.map((d) => (
                <li key={d.path} className="flex items-center gap-3 px-6 py-3.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-soft-foreground">
                    <FileText className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-medium text-foreground truncate" title={d.name}>{d.name}</span>
                  {d.size != null && <span className="text-xs text-muted-foreground shrink-0">{formatFileSize(d.size)}</span>}
                  {d.chunks != null && (
                    <span title="Passages indexed for grounding" className="shrink-0">
                      {d.chunks > 0 ? <Tag>{d.chunks} chunks</Tag> : <StatusPill tone="warning" dot={false}>Not indexed</StatusPill>}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-4 pl-2 shrink-0">
                    <TextAction onActivate={() => void handleDownload(d.name)}>Download</TextAction>
                    {isEditor && <TextAction tone="danger" onActivate={() => void handleDelete(d.name)}>Delete</TextAction>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      </div>

      {/* ── Right rail: reference index status + upload ───────────────────── */}
      <aside className="space-y-4 min-w-0">
        <Panel tone="ink" className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[1.0625rem] font-bold text-white">Document search</h3>
            {(() => {
              const st = docsIndexState(status, syncing);
              if (!st) return null;
              const color = st.tone === 'success' ? 'text-[#5fd39d]' : st.tone === 'warning' ? 'text-warning' : st.tone === 'danger' ? 'text-[#ff9b8b]' : 'text-ink-muted';
              return <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${color}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{st.label}</span>;
            })()}
          </div>
          <p className="text-sm text-ink-foreground/85">
            Documents are parsed into passages and indexed with Vector Search. The most relevant passages ground attribute discovery and SQL generation.
          </p>
          <RailRow ink label="Documents" value={loading ? '…' : docs.length} />
          {status?.index && <RailRow ink label="Indexed passages" value={status.index.chunks} />}
          {status?.index && <RailRow ink label="Last indexed" value={fmtWhen(status.index.lastIndexedAt)} />}
          {status?.index?.lastError && <p className="text-xs text-[#ff9b8b] break-words">{status.index.lastError}</p>}
          {isEditor && status?.configured && (
            <button
              type="button"
              onClick={() => void handleSync()}
              disabled={syncing}
              className="flex w-full items-center justify-center gap-2 rounded-[0.625rem] border border-white/20 bg-transparent px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-50 disabled:pointer-events-none"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} /> {syncing ? 'Indexing…' : 'Re-index documents'}
            </button>
          )}
        </Panel>

        {isEditor && (
          <Panel className="p-5 space-y-3">
            <h3 className="text-[1.0625rem] font-bold">Upload reference documents</h3>
            <p className="text-sm text-muted-foreground">
              PDF, DOCX, PPTX or images. Each upload is parsed and indexed automatically (up to 500 pages / 100 MB per file).
            </p>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept=".pdf,.txt,.md,.docx,.ppt,.pptx"
              className="hidden"
              onChange={(e) => void handleFiles(e.target.files)}
            />
            <Button className="w-full" onClick={() => fileInput.current?.click()} disabled={busy}>
              <Upload className="h-4 w-4" /> {busy ? 'Uploading…' : 'Choose Files'}
            </Button>
          </Panel>
        )}
      </aside>
    </div>
  );
}

// Max instruction length. Generous for real guidance (~600–800 words) while keeping
// the per-call prompt overhead bounded (the text is injected verbatim into every
// identify + generate call for the source system).
const MAX_INSTRUCTIONS = 4000;

// Per-source-system mapping instructions: admin/editor-authored natural-language guidance
// injected into the identify + generate prompts. Viewers see it read-only.
function MappingInstructionsTab() {
  const { isEditor } = useRole();
  const [domains, setDomains] = useState<string[]>([]);
  const [domain, setDomain] = useState('');
  const [text, setText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [updatedBy, setUpdatedBy] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.sourceSystems().then((d) => {
      setDomains(d.sourceSystems);
      setDomain((cur) => cur || d.defaultSourceSystem || d.sourceSystems[0] || 'Epic');
    }).catch(() => { setDomains(['Epic']); setDomain((cur) => cur || 'Epic'); });
  }, []);

  const load = useCallback((dom: string) => {
    if (!dom) return;
    setLoading(true);
    setMsg(null);
    setError(null);
    api.sourceSystemInstructions(dom).then((r) => {
      instructionsCache = { domain: dom, text: r.instructions ?? '', updatedAt: r.updatedAt };
      setText(r.instructions ?? '');
      setSavedText(r.instructions ?? '');
      setUpdatedBy(r.updatedBy);
      setUpdatedAt(r.updatedAt);
    }).catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(domain); }, [domain, load]);

  async function handleSave() {
    setSaving(true);
    setMsg(null);
    setError(null);
    try {
      await api.saveSourceSystemInstructions(domain, text);
      setSavedText(text);
      setMsg(`Saved mapping instructions for ${domain}. New mappings for this source system will use them.`);
      // Refresh the audit line.
      load(domain);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const dirty = text !== savedText;
  const overLimit = text.length > MAX_INSTRUCTIONS;

  return (
    <div className="space-y-4 max-w-4xl">
      <p className="text-sm text-muted-foreground">
        Natural-language guidance for a source system (EHR type), injected into the attribute-discovery and
        SQL-generation prompts for every mapping in that source system. Use it for naming conventions, preferred source
        tables, date formats, and mapping rules. The model follows it wherever it applies — it does not override
        the app’s hard safety rules (read-only SQL, type casting).
      </p>

      <Panel>
        <PanelHeader
          title="Source system instructions"
          description={isEditor ? 'Select a source system and edit its mapping guidance.' : 'Guidance in effect for each source system (read-only).'}
          actions={
            <div className="space-y-1.5 w-56">
              <Label>Source System</Label>
              <SearchableSelect
                value={domain}
                onValueChange={setDomain}
                className="w-full"
                placeholder="Select source system"
                options={domains.map((d) => ({ value: d, label: d }))}
              />
            </div>
          }
        />
        <div className="space-y-3 border-t border-border px-6 py-5">
          {error && <Notice tone="error">{error}</Notice>}
          {loading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={!isEditor || saving}
                placeholder={isEditor ? 'e.g. Prefer columns from patient_master over patient_staging. Dates are MM/DD/YYYY — use try_to_date(x, \'MM/dd/yyyy\'). Treat MRN as the patient identifier.' : 'No instructions set for this source system.'}
                className="h-64 text-sm bg-surface-sunken"
              />
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <span className={`text-xs ${overLimit ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {text.length.toLocaleString()} / {MAX_INSTRUCTIONS.toLocaleString()} characters
                  {updatedBy && !dirty && <span className="ml-2">· last updated by {updatedBy.split('@')[0]}{updatedAt ? ` on ${fmtWhen(updatedAt)}` : ''}</span>}
                </span>
                {isEditor && (
                  <Button onClick={() => void handleSave()} disabled={saving || !dirty || overLimit}>
                    <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save instructions'}
                  </Button>
                )}
              </div>
              {overLimit && <p className="text-xs text-destructive">Instructions exceed the {MAX_INSTRUCTIONS.toLocaleString()}-character limit. Trim before saving.</p>}
              {msg && <Notice tone="info">{msg}</Notice>}
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}

const REF_TABS = [
  { key: 'examples', label: 'Mapping examples' },
  { key: 'documents', label: 'Reference documents' },
  { key: 'instructions', label: 'Mapping instructions' },
] as const;

export function ReferencesPage() {
  const [tab, setTab] = useState<'examples' | 'documents' | 'instructions'>('examples');
  // Header action slot: the Examples tab portals its "Add an example" button here so
  // its form state stays inside the tab.
  const [actionSlot, setActionSlot] = useState<HTMLDivElement | null>(null);
  const [counts, setCounts] = useState<{ examples: number | null; documents: number | null }>({
    examples: examplesCache?.length ?? null,
    documents: docsCache?.length ?? null,
  });
  const setExampleCount = useCallback((n: number) => setCounts((c) => (c.examples === n ? c : { ...c, examples: n })), []);
  const setDocCount = useCallback((n: number) => setCounts((c) => (c.documents === n ? c : { ...c, documents: n })), []);

  return (
    <div className="space-y-6 w-full">
      <PageHeader
        eyebrow="Knowledge"
        title="Mapping references"
        description="Curated SQL examples, reference documents and per-system instructions injected into mapping prompts — no retraining needed."
        actions={<div ref={setActionSlot} className="contents" />}
      />

      <div className="space-y-6">
        {/* Sub-menu: horizontal underline tabs below the page header. */}
        <div role="tablist" className="flex flex-nowrap items-center gap-6 sm:gap-8 border-b border-border overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {REF_TABS.map((t) => {
            const count = t.key === 'examples' ? counts.examples : t.key === 'documents' ? counts.documents : null;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.key)}
                className={cn(
                  'whitespace-nowrap border-b-2 -mb-px px-1 py-3 text-[0.9375rem] font-semibold transition-colors',
                  active ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
                {count !== null && <span className="ml-2 text-xs font-semibold text-muted-foreground">{count}</span>}
              </button>
            );
          })}
        </div>

        <div className="min-w-0 w-full">
          {tab === 'examples' ? (
            <MappingExamplesTab actionSlot={actionSlot} onCount={setExampleCount} />
          ) : tab === 'documents' ? (
            <ReferenceDocsTab onCount={setDocCount} />
          ) : (
            <MappingInstructionsTab />
          )}
        </div>
      </div>
    </div>
  );
}
