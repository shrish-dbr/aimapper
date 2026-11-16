import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import {
  Button,
  Label,
  Alert,
  AlertTitle,
  AlertDescription,
  Textarea,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  Checkbox,
  Slider,
} from '@databricks/appkit-ui/react';
import { Wand2, Search, Sparkles, CheckCircle2, Save, Star, Download, TableProperties, FileSpreadsheet, FileText, ChevronDown, GitBranch, History, Layers, ThumbsUp, ThumbsDown, Copy, Check, Wrench } from 'lucide-react';
import { api, LARGE_SELECTION_WARN, type AttributeMapping, type TargetEntity, type SourceTable, type RunItem, type ValidationReport, type Project, type ReferenceSource } from '../../lib/aimapperApi';
import { setGenieSession } from '../../lib/genieSession';
import { useRole } from '../../lib/roleContext';
import { SearchableSelect } from './SearchableSelect';
import { PageHeader, Panel, StepHeading, StatusPill, Mono, SearchField } from '../../components/studio';
import { statusTone, statusLabel } from '../../lib/display';

const CONFIDENCE_THRESHOLD = 0.6;

/** State passed from History → "Load into Mapper". Exported so History can build it. */
export interface ReloadPayload {
  catalog: string;
  schema: string;
  targetTable: string;
  mappings: AttributeMapping[];
  sql: string | null;
  version: number | null;
  sourceSystem?: string | null;
  projectId?: string | null;
}

interface BulkResult {
  target: string;
  status: 'pending' | 'running' | 'SUCCESS' | 'WARNINGS' | 'FAILED';
  mapped?: number;
  total?: number;
  error?: string;
  // Rich per-target detail (populated once generation completes), so each row can
  // show SQL + preview + retrieval/token info and be saved individually — parity
  // with single-target mode.
  sql?: string | null;
  item?: RunItem;
  mappings?: AttributeMapping[];
  examplesUsed?: number;
  referenceUsed?: boolean;
  referenceSources?: ReferenceSource[];
  retrievalMethod?: 'vector_search' | 'lexical';
  selectedEndpoint?: string;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  // Per-row UI state.
  expanded?: boolean;
  preview?: PreviewData | null;
  previewError?: string | null;
  previewing?: boolean;
  validating?: boolean;
  saved?: boolean;
  saving?: boolean;
  savedExample?: boolean;
  savingExample?: boolean;
  regenerating?: boolean;
  instructions?: string; // per-run refine instructions for THIS target (ephemeral)
}

interface PreviewData {
  columns: string[];
  rows: (string | null)[][];
}

interface SqlRow {
  sql: string;
  report: ValidationReport | null;
  status: RunItem['status'] | 'PENDING';
  error: string | null;
  durationMs: number | null;
  validated: boolean;
  examplesUsed: number;
  referenceUsed: boolean;
  /** Passages that grounded this mapping (Vector Search mode). */
  referenceSources?: ReferenceSource[];
  savedExample: boolean;
  /** True once this mapping has been saved to History — disables re-saving (and
   * Save as Example) so the same validated result isn't submitted twice. Cleared
   * when the SQL is edited or regenerated. */
  savedHistory?: boolean;
  preview: PreviewData | null;
  previewError: string | null;
  /** Total LLM tokens for this task = identify + generate. */
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  /** Which few-shot retrieval produced the examples used for this generation. */
  retrievalMethod?: 'vector_search' | 'lexical';
  /** The endpoint actually used (set when auto-selection routed the run). */
  selectedEndpoint?: string;
  /** True when the prompt-size guard trimmed samples/few-shot to fit the context. */
  promptTrimmed?: boolean;
  /** Count of injected reference examples whose SQL exceeded the per-example cap and was truncated. */
  examplesTruncated?: number;
  /** True when this row was loaded from History/Approvals via "Inspect" (read-only
   * review). Such rows are never savable — inspecting must not create duplicates or
   * new examples, even after re-validating. Cleared once the user regenerates. */
  inspected?: boolean;
}

// Parse the top-level SELECT list of a generated JOIN statement into a map of
// {target alias (lowercased) -> the actual SQL expression that produces it}. Used by
// the mapping exports so they carry the real per-column transformation, e.g.
// "try_to_date(p.dob, 'MM/dd/yyyy')" for birth_date. Splits only on TOP-LEVEL commas
// (respecting nested parens and string literals), and strips the trailing "AS alias".
// Best-effort: returns an empty map if it can't find/parse a SELECT.
function parseSelectExpressions(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!sql) return out;
  // Isolate the SELECT ... FROM span (top-level FROM only).
  const selMatch = /\bselect\b/i.exec(sql);
  if (!selMatch) return out;
  const afterSelect = selMatch.index + selMatch[0].length;
  // Walk to the top-level FROM (depth 0, not inside quotes).
  let depth = 0, quote: string | null = null, fromIdx = -1;
  for (let i = afterSelect; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /\s/.test(sql[i - 1] ?? ' ') && /from/i.test(sql.slice(i, i + 4)) && /\s|$/.test(sql[i + 4] ?? ' ')) {
      fromIdx = i; break;
    }
  }
  const listStr = sql.slice(afterSelect, fromIdx === -1 ? undefined : fromIdx);
  // Split on top-level commas.
  const parts: string[] = [];
  depth = 0; quote = null;
  let start = 0;
  for (let i = 0; i < listStr.length; i++) {
    const ch = listStr[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { parts.push(listStr.slice(start, i)); start = i + 1; }
  }
  parts.push(listStr.slice(start));
  for (const raw of parts) {
    const item = raw.trim();
    if (!item) continue;
    // Strip a trailing "AS alias" or bare " alias" (backtick/plain). Prefer explicit AS.
    const asMatch = /\bas\s+`?([A-Za-z_][\w]*)`?\s*$/i.exec(item);
    if (asMatch) {
      out.set(asMatch[1].toLowerCase(), item.slice(0, asMatch.index).trim());
      continue;
    }
    // Fallback: "<expr> alias" where alias is a trailing bareword and expr has more.
    const bareMatch = /^(.*\S)\s+`?([A-Za-z_][\w]*)`?\s*$/.exec(item);
    if (bareMatch && /[\s().]/.test(bareMatch[1])) {
      out.set(bareMatch[2].toLowerCase(), bareMatch[1].trim());
    }
  }
  return out;
}

// [DATA-SAMPLING] Sample-size (example values per source column) range for the per-run
// slider. Mirrors the server clamp in dataSampling.ts. Remove this block with the feature.
const DEFAULT_SAMPLE_VALUES = 3;
const MIN_SAMPLE_VALUES = 1;
const MAX_SAMPLE_VALUES = 100;
const COMPLEX_TYPE_RE = /^(struct|array|map|binary|interval|variant)/i;
/** Rough estimate of the tokens the sample block adds to each generate, so the slider
 * can show live impact. Approximate — mirrors the shape produced by dataSampling.ts. */
function estimateSampleTokens(sources: SourceTable[], mappings: AttributeMapping[], valuesPerColumn: number): number {
  const used = new Set(mappings.map((m) => m.source_table).filter((t): t is string => !!t));
  const tables = used.size ? sources.filter((s) => used.has(s.table)) : sources;
  let cols = 0;
  for (const t of tables) for (const c of t.columns) if (!COMPLEX_TYPE_RE.test(c.typeName)) cols++;
  if (cols === 0) return 0;
  // ~8 tokens per table header + ~6 per column line + ~6 per shown value; capped like the server block (~10k tokens).
  return Math.min(tables.length * 8 + cols * (6 + valuesPerColumn * 6), 10000);
}

// [SELF-HEAL] Max automatic "feed the compile error back to the model and re-generate"
// attempts when generated SQL fails to compile.
const MAX_AUTO_REPAIR = 2;

/** Repair instruction fed back to the model when generated SQL fails to compile. */
function repairDirective(errorMessage: string): string {
  return (
    'The SQL you previously generated FAILED to compile in Databricks (Spark SQL) with this exact error:\n' +
    errorMessage +
    '\nReturn a corrected single read-only SELECT that fixes this error. Keep every target column and its ' +
    'alias in order, keep it read-only (SELECT/JOIN only), and keep the required type casts.'
  );
}

// Module-level snapshot of the Mapper's working state, so navigating away and back
// restores where the user left off (survives route changes; resets on full reload).
interface MapperSnapshot {
  projectId: string;
  crossProject: boolean;
  sampleData: boolean; // [DATA-SAMPLING]
  sampleValues: number; // [DATA-SAMPLING]
  catalog: string;
  schema: string;
  targetEntity: string;
  endpoint: string;
  mappings: AttributeMapping[];
  sources: SourceTable[];
  row: SqlRow | null;
  matchTokens: number;
}
let mapperCache: MapperSnapshot | null = null;

function confidenceBadge(conf: number) {
  const dot = conf >= 0.8 ? 'bg-success' : conf >= CONFIDENCE_THRESHOLD ? 'bg-warning' : 'bg-brand';
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[0.8125rem] font-semibold tabular-nums">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {Math.round(conf * 100)}%
    </span>
  );
}

/** Run-level confidence = mean confidence of the mapped columns (null if none). */
function meanConfidence(mappings: AttributeMapping[]): number | null {
  const mapped = mappings.filter((m) => m.source_table && m.source_column);
  if (mapped.length === 0) return null;
  return mapped.reduce((sum, m) => sum + (m.confidence || 0), 0) / mapped.length;
}

export function MapperPage() {
  const { isEditor, prefs } = useRole();
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [endpoints, setEndpoints] = useState<string[]>([]);
  const [targets, setTargets] = useState<TargetEntity[]>([]);
  const [catalog, setCatalog] = useState('');
  const [schema, setSchema] = useState('');
  const [targetEntity, setTargetEntity] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [autoModelSelect, setAutoModelSelect] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [defaultSourceSystem, setDefaultSourceSystem] = useState('Epic');
  // Cross-Project Learning: when on, generation pulls approved examples & history from
  // ALL projects of the same source system, not just the current project.
  const [crossProject, setCrossProject] = useState(true);
  // [DATA-SAMPLING] per-run toggle: sample real source values into the generation prompt,
  // and the sample size = how many example values per source column to include.
  const [sampleData, setSampleData] = useState(false);
  const [sampleValues, setSampleValues] = useState(DEFAULT_SAMPLE_VALUES);
  const [loadingLists, setLoadingLists] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);

  const [sources, setSources] = useState<SourceTable[]>([]);
  const [mappings, setMappings] = useState<AttributeMapping[]>([]);
  const [matchError, setMatchError] = useState<string | null>(null);
  // Non-fatal warning surfaced after Identify (e.g. the matching response was truncated
  // and only partially recovered, so some columns may be unmapped).
  const [matchWarning, setMatchWarning] = useState<string | null>(null);
  const [identifying, setIdentifying] = useState(false);
  // Tokens spent by the identify step, carried into the task total on generate.
  const [matchTokens, setMatchTokens] = useState(0);

  const [row, setRow] = useState<SqlRow | null>(null);
  const [generating, setGenerating] = useState(false);
  // [SELF-HEAL] >0 while auto-repairing a compile failure (shows the attempt number).
  const [repairAttempt, setRepairAttempt] = useState(0);
  const [validating, setValidating] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  // Auto-scroll: after Identify / Generate completes, bring the result section into view.
  const mappingsSectionRef = useRef<HTMLDivElement | null>(null);
  const sqlSectionRef = useRef<HTMLDivElement | null>(null);
  const [scrollTarget, setScrollTarget] = useState<'mappings' | 'sql' | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingExample, setSavingExample] = useState(false);
  const [sqlCopied, setSqlCopied] = useState(false);
  // Per-run, ephemeral instructions for THIS mapping (e.g. "cast amounts to DECIMAL(18,2)").
  // Merged with source-system instructions on the server and applied on (re)generate.
  const [userInstructions, setUserInstructions] = useState('');
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [showLineage, setShowLineage] = useState(false);
  const [gridFilter, setGridFilter] = useState('');
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkResults, setBulkResults] = useState<BulkResult[]>([]);
  const [bulkItems, setBulkItems] = useState<RunItem[]>([]);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkSaved, setBulkSaved] = useState(false);
  // Which targets the bulk run should map. Defaults to all; the user can deselect.
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  // Which source tables to search for matching attributes. Defaults to all; the user
  // can deselect tables to narrow the search (fewer tables = faster, more focused).
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());

  const [reloadNote, setReloadNote] = useState<string | null>(null);
  const location = useLocation();

  const targetNames = useMemo(() => targets.map((t) => t.target_table), [targets]);
  const targetByName = useMemo(() => new Map(targets.map((t) => [t.target_table, t])), [targets]);

  // The selected project + its source system (one source system per project). All
  // mapping calls scope by (sourceSystem, projectId); crossProject widens retrieval.
  const currentProject = useMemo(() => projects.find((p) => p.project_id === projectId) ?? null, [projects, projectId]);
  const sourceSystem = currentProject?.source_system ?? defaultSourceSystem;
  // schema version is a project attribute — it drives which target contract the flow maps
  // against. Derived from the selected project (no separate selector on this page).
  const schemaVersion = currentProject?.schema_version_id ?? '';

  // Default the bulk selection to every target once the list loads (only while empty,
  // so a user's manual deselection isn't clobbered on re-render).
  useEffect(() => {
    if (targetNames.length && selectedTargets.size === 0) {
      setSelectedTargets(new Set(targetNames));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetNames]);

  // Load the target contract for the selected project's schema version. Fires when the
  // version resolves (project loaded) and whenever the user switches to a project on a
  // different version. On a genuine version *switch* the dependent state is reset; the
  // first load and snapshot/history restores are preserved (guarded by reloadingRef).
  const prevVersionRef = useRef<string>('');
  useEffect(() => {
    if (!schemaVersion) return;
    const prev = prevVersionRef.current;
    const switched = prev !== '' && prev !== schemaVersion;
    prevVersionRef.current = schemaVersion;
    let active = true;
    void (async () => {
      try {
        const p = await api.targetEntities(schemaVersion);
        if (!active) return;
        setTargets(p.targets);
        setSelectedTargets(new Set(p.targets.map((t) => t.target_table)));
        if (switched && !reloadingRef.current) {
          // Version actually changed under the user → the contract is different, so
          // drop a now-invalid target selection and any in-progress mapping.
          const names = new Set(p.targets.map((t) => t.target_table));
          setTargetEntity((cur) => (names.has(cur) ? cur : ''));
          setMappings([]);
          setRow(null);
        }
      } catch {
        /* leave the previous targets in place on error */
      }
    })();
    return () => { active = false; };
  }, [schemaVersion]);

  // Source tables actually chosen for the search (in schema order).
  const chosenTables = useMemo(() => tables.filter((t) => selectedTables.has(t)), [tables, selectedTables]);

  // A default schema from user prefs can only be applied once the chosen
  // catalog's schemas have loaded — stash it here for the schema effect to pick up.
  const pendingDefaultSchema = useRef<string | null>(null);

  // Publish the current mapping session to the floating Genie assistant so
  // mapping questions are scoped to what is on screen; clear it on leave.
  useEffect(() => {
    setGenieSession({ targetTable: targetEntity || undefined, domain: sourceSystem || undefined, projectId: projectId || undefined });
  }, [targetEntity, sourceSystem, projectId]);
  useEffect(() => () => setGenieSession({}), []);

  useEffect(() => {
    void (async () => {
      setLoadingLists(true);
      try {
        const [c, e, p, d, ms] = await Promise.all([
          api.catalogs(), api.endpoints(), api.targetEntities(), api.projects(),
          api.getModelSelection().catch(() => ({ autoSelect: false, tiers: { strong: '', standard: '', light: '' } })),
        ]);
        setCatalogs(c.catalogs);
        setAutoModelSelect(ms.autoSelect === true);
        const endpointNames = e.endpoints.map((x) => x.name);
        setEndpoints(endpointNames);
        // First-paint targets (default version); the version effect reloads for the
        // selected project's schema version once the project resolves.
        setTargets(p.targets);
        setProjects(d.projects);
        setDefaultSourceSystem(d.defaultSourceSystem);
        const firstProject = d.projects[0]?.project_id ?? '';

        // If the user navigated away mid-task and came back, restore the snapshot
        // instead of applying defaults. Guard the reset-on-change effect during
        // hydration (like the history reload) so downstream state isn't wiped.
        const isHistoryReload = !!(location.state as { reload?: ReloadPayload } | null)?.reload;
        // "Open in Mapper" from the Projects page deep-links a project → fresh mapper
        // scoped to it (skip snapshot restore).
        const selectProject = (location.state as { selectProject?: string } | null)?.selectProject;
        if (selectProject) window.history.replaceState({}, '');
        if (mapperCache && !isHistoryReload && !selectProject) {
          const snap = mapperCache;
          reloadingRef.current = true;
          // Hold the guard until the catalog→schema cascade lands on this triple.
          hydratingTo.current = { catalog: snap.catalog, schema: snap.schema, targetEntity: snap.targetEntity };
          setProjectId(snap.projectId || firstProject);
          setCrossProject(snap.crossProject ?? true);
          setSampleData(snap.sampleData ?? false); // [DATA-SAMPLING]
          setSampleValues(snap.sampleValues ?? DEFAULT_SAMPLE_VALUES); // [DATA-SAMPLING]
          setEndpoint(snap.endpoint || endpointNames[0] || '');
          setTargetEntity(snap.targetEntity);
          setMappings(snap.mappings);
          setSources(snap.sources);
          setRow(snap.row);
          setMatchTokens(snap.matchTokens);
          if (snap.catalog) {
            pendingDefaultSchema.current = snap.schema || null;
            setCatalog(snap.catalog);
          } else {
            // Nothing to cascade — release immediately.
            reloadingRef.current = false;
            hydratingTo.current = null;
          }
          return; // skip default application
        }

        setProjectId((prev) => selectProject || prev || firstProject);
        // Apply per-user defaults (Settings page) where the option still exists.
        const prefEndpoint = prefs.defaultEndpoint && endpointNames.includes(prefs.defaultEndpoint) ? prefs.defaultEndpoint : null;
        // Auto-select is on by default → default the picker to "Auto (by task size)"
        // unless the user has set a personal default endpoint (which always wins).
        setEndpoint(prefEndpoint ?? (ms.autoSelect === true ? 'auto' : (endpointNames[0] ?? '')));
        if (prefs.defaultTarget && p.targets.some((t) => t.target_table === prefs.defaultTarget)) {
          setTargetEntity(prefs.defaultTarget);
        }
        if (prefs.defaultCatalog && c.catalogs.includes(prefs.defaultCatalog)) {
          pendingDefaultSchema.current = prefs.defaultSchema ?? null;
          setCatalog(prefs.defaultCatalog);
        }
      } catch (err) {
        setTopError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingLists(false);
        // Lists loaded + defaults/restore applied — allow the persistence effect to
        // start capturing snapshots from here on (see hydratedRef note above).
        hydratedRef.current = true;
      }
    })();
    // Runs once on mount; prefs are stable after the initial context load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setSchema('');
    setTables([]);
    if (!catalog) return;
    void (async () => {
      try {
        const s = (await api.schemas(catalog)).schemas;
        setSchemas(s);
        // Apply a pending default schema from prefs, if it's valid for this catalog.
        const want = pendingDefaultSchema.current;
        pendingDefaultSchema.current = null;
        if (want && s.includes(want)) setSchema(want);
      } catch (err) {
        setTopError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [catalog]);

  useEffect(() => {
    setTables([]);
    setSelectedTables(new Set());
    if (!catalog || !schema) return;
    void (async () => {
      try {
        const t = (await api.tables(catalog, schema)).tables;
        setTables(t);
        // Default: nothing selected. Auto-selecting every table on a wide schema sends
        // thousands of columns to discovery; the user picks tables (or clicks All).
        setSelectedTables(new Set());
      } catch (err) {
        setTopError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [catalog, schema]);

  // When the user changes source/target selections manually, clear downstream
  // state. Suppressed while hydrating (history reload or navigation-return restore):
  // `hydratingTo` holds the selector triple we're restoring to, and we keep the guard
  // until the async catalog→schema cascade lands on it — then release deterministically.
  // (A timer can't work: the cascade sets `schema` only after awaiting api.schemas().)
  const reloadingRef = useRef(false);
  const hydratingTo = useRef<{ catalog: string; schema: string; targetEntity: string } | null>(null);
  // Gate for the persistence effect (declared here so the async initial-load effect,
  // which runs earlier in source order, can flip it in its finally block).
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (reloadingRef.current) {
      const h = hydratingTo.current;
      // Once the cascade has settled on the hydration target, release the guard so
      // subsequent genuine user edits reset normally. Don't clear downstream state.
      if (h && catalog === h.catalog && schema === h.schema && targetEntity === h.targetEntity) {
        reloadingRef.current = false;
        hydratingTo.current = null;
      }
      return;
    }
    setMappings([]);
    setSources([]);
    setRow(null);
    setMatchError(null);
    setSaveMsg(null);
    setReloadNote(null);
  }, [targetEntity, catalog, schema]);

  // Reload a saved mapping from History (navigated with location.state.reload).
  useEffect(() => {
    const reload = (location.state as { reload?: ReloadPayload } | null)?.reload;
    if (!reload) return;
    reloadingRef.current = true;
    hydratingTo.current = { catalog: reload.catalog, schema: reload.schema, targetEntity: reload.targetTable };
    void (async () => {
      try {
        setCatalog(reload.catalog);
        setSchema(reload.schema);
        setTargetEntity(reload.targetTable);
        if (reload.projectId) setProjectId(reload.projectId);
        const mps = reload.mappings ?? [];
        setMappings(mps);
        // Re-fetch source-table schemas so the grid dropdowns work.
        const usedTables = [...new Set(mps.map((m) => m.source_table).filter((t): t is string => !!t))];
        if (usedTables.length && reload.catalog && reload.schema) {
          const { sources: srcs } = await api.sourceSchemas(reload.catalog, reload.schema, usedTables);
          setSources(srcs);
        }
        if (reload.sql) {
          setRow({
            sql: reload.sql, report: null, status: 'EDITED', error: null, durationMs: null,
            validated: false, examplesUsed: 0, referenceUsed: false, savedExample: false, preview: null, previewError: null,
            totalTokens: 0, promptTokens: 0, completionTokens: 0, inspected: true,
          });
        }
        setReloadNote(`Inspecting ${reload.targetTable}${reload.version ? ` v${reload.version}` : ''} from history — read-only. Validate to check it; to create a new version, regenerate the mapping.`);
      } catch (err) {
        setTopError(err instanceof Error ? err.message : String(err));
        // On error the cascade may never reach the target — release so the UI isn't stuck.
        reloadingRef.current = false;
        hydratingTo.current = null;
      } finally {
        // The reset-on-change effect releases the guard once the cascade settles on
        // hydratingTo; no timer needed. Clear router state so a refresh doesn't re-trigger.
        window.history.replaceState({}, '');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  // Persist the working state so leaving and returning to the Mapper restores it.
  // Gated by `hydratedRef`: the initial-load effect is async, so on remount this
  // effect would otherwise fire FIRST with empty initial state and clobber the cache
  // before the restore runs. We only start persisting once hydration has finished.
  // Also skipped while `reloadingRef` is set (mid-restore) so it doesn't thrash.
  useEffect(() => {
    if (!hydratedRef.current || reloadingRef.current) return;
    mapperCache = { projectId, crossProject, sampleData, sampleValues, catalog, schema, targetEntity, endpoint, mappings, sources, row, matchTokens };
  }, [projectId, crossProject, sampleData, sampleValues, catalog, schema, targetEntity, endpoint, mappings, sources, row, matchTokens]);

  // Runs after the result card has rendered, so the ref is attached before scrolling.
  // NOTE: no cleanup that cancels the scroll — clearing scrollTarget re-runs this
  // effect, and a cancel in the cleanup would abort the pending scroll every time.
  useEffect(() => {
    if (!scrollTarget) return;
    const el = scrollTarget === 'mappings' ? mappingsSectionRef.current : sqlSectionRef.current;
    // Always clear the request so a stale target can't trigger a scroll later.
    setScrollTarget(null);
    if (!el) return;
    // Small delay lets the card finish laying out (and the busy button state clear)
    // before scrolling, so the final position is accurate.
    window.setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  }, [scrollTarget, mappings, matchError, row]);

  const ready = Boolean(catalog && schema && targetEntity && endpoint && chosenTables.length);

  async function handleIdentify() {
    const target = targetByName.get(targetEntity);
    if (!target) return;
    setIdentifying(true);
    setTopError(null);
    setMatchError(null);
    setMatchWarning(null);
    setRow(null);
    setSaveMsg(null);
    try {
      const { sources: srcs } = await api.sourceSchemas(catalog, schema, chosenTables);
      setSources(srcs);
      const { mappings: m, tokens, truncated, discovery } = await api.matchAttributes(endpoint, target, srcs, sourceSystem, projectId);
      setMappings(m);
      setMatchTokens(tokens?.totalTokens ?? 0);
      const warnings: string[] = [];
      if (truncated) warnings.push('The matching response was truncated or a discovery batch failed — some columns may be left unmapped. Re-run Identify Mappings to retry.');
      if (discovery && discovery.skippedTables.length > 0) {
        const shown = discovery.skippedTables.slice(0, 8).join(', ');
        const more = discovery.skippedTables.length > 8 ? ` and ${discovery.skippedTables.length - 8} more` : '';
        warnings.push(`Large selection: searched the ${discovery.tablesSearched} most relevant of ${discovery.tablesSelected} tables (${discovery.batches} batch(es)). Not searched: ${shown}${more}. Select fewer tables for more precise matching.`); // reconstructed: tail of message cut off at right edge
      }
      setMatchWarning(warnings.length ? warnings.join(' ') : null);
      setScrollTarget('mappings');
    } catch (err) {
      setMatchError(err instanceof Error ? err.message : String(err));
      setScrollTarget('mappings');
    } finally {
      setIdentifying(false);
    }
  }

  // ── Feature 3: bulk / all-entities mode ──────────────────────────────────
  // Discover + generate + validate every target, hold the results for review,
  // and let the user save to history MANUALLY (like single-target mode).
  async function handleBulkRun() {
    if (!catalog || !schema || !endpoint || !chosenTables.length || targets.length === 0) return;
    // Only map the targets the user selected.
    const chosen = targets.filter((t) => selectedTargets.has(t.target_table));
    if (chosen.length === 0) { setTopError('Select at least one target to map.'); return; }
    setBulkRunning(true);
    setTopError(null);
    setSaveMsg(null);
    setBulkItems([]);
    setBulkSaved(false);
    setBulkResults(chosen.map((t) => ({ target: t.target_table, status: 'pending' })));
    try {
      // Fetch source schemas once for the selected tables.
      const { sources: srcs } = await api.sourceSchemas(catalog, schema, chosenTables);

      // Map one target end-to-end (identify → generate → validate), returning its
      // enriched result. Errors are captured per-target so one failure doesn't abort
      // the whole run.
      const mapOne = async (t: TargetEntity): Promise<BulkResult> => {
        const started = performance.now();
        try {
          const match = await api.matchAttributes(endpoint, t, srcs, sourceSystem, projectId);
          const m = match.mappings;
          const gen = await api.generateJoinSql(endpoint, t, srcs, m, sourceSystem, { projectId, crossProject, sampleData, sampleValues }); // [DATA-SAMPLING]
          const taskTok = {
            prompt: (match.tokens?.promptTokens ?? 0) + (gen.tokens?.promptTokens ?? 0),
            completion: (match.tokens?.completionTokens ?? 0) + (gen.tokens?.completionTokens ?? 0),
            total: (match.tokens?.totalTokens ?? 0) + (gen.tokens?.totalTokens ?? 0),
          };
          let status: RunItem['status'] = 'FAILED';
          let report = null as RunItem['validationReport'];
          let error: string | null = null;
          if (gen.readOnly) {
            const v = await api.validateSql(gen.sql, t);
            report = v.report;
            status = v.report.status === 'SUCCESS' || v.report.status === 'WARNINGS' ? v.report.status : 'FAILED';
            error = v.report.errorMessage ?? null;
          } else {
            error = gen.outputTruncated
              ? (gen.message ?? 'SQL generation hit the output token limit — raise the Prompt Sizing profile (Admin → Prompt sizing) and regenerate.')
              : 'Generated SQL is not read-only';
          }
          const used = [...new Set(m.map((x) => x.source_table).filter((s): s is string => !!s))].sort();
          const mappedN = m.filter((x) => x.source_table && x.source_column).length;
          const item: RunItem = {
            itemId: crypto.randomUUID(), sourceCatalog: catalog, sourceSchema: schema,
            sourceTable: used.join(', ') || '(none)', targetTable: t.target_table,
            matchMethod: 'bulk_attribute_discovery', matchConfidence: meanConfidence(m),
            matchRationale: `${mappedN}/${m.length} attributes mapped across ${used.length} table(s)`,
            generatedSql: gen.sql, status, validationReport: report, errorMessage: error,
            durationMs: Math.round(performance.now() - started), mappingsJson: JSON.stringify(m), sourceSystem, projectId,
            promptTokens: taskTok.prompt, completionTokens: taskTok.completion, totalTokens: taskTok.total,
          };
          return {
            target: t.target_table, status: status as BulkResult['status'], mapped: mappedN, total: m.length,
            error: status === 'FAILED' ? error ?? undefined : undefined,
            sql: gen.sql, item, mappings: m,
            examplesUsed: gen.examplesUsed, referenceUsed: gen.referenceUsed ?? false, referenceSources: gen.referenceSources, retrievalMethod: gen.retrievalMethod, selectedEndpoint: gen.selectedEndpoint,
            totalTokens: taskTok.total, promptTokens: taskTok.prompt, completionTokens: taskTok.completion,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const item: RunItem = {
            itemId: crypto.randomUUID(), sourceCatalog: catalog, sourceSchema: schema, sourceTable: '(error)',
            targetTable: t.target_table, matchMethod: 'bulk_attribute_discovery', matchConfidence: null,
            matchRationale: null, generatedSql: null, status: 'FAILED', validationReport: null,
            errorMessage: msg, durationMs: Math.round(performance.now() - started), mappingsJson: null, sourceSystem, projectId,
          };
          return { target: t.target_table, status: 'FAILED', error: msg, sql: null, item };
        }
      };

      // Bounded-concurrency pool: run up to POOL targets at once, refilling as each
      // finishes. Faster than sequential without hammering the LLM endpoint/warehouse.
      const POOL = 4;
      let next = 0;
      const items: RunItem[] = [];
      const worker = async () => {
        while (next < chosen.length) {
          const i = next++;
          const t = chosen[i];
          setBulkResults((prev) => prev.map((r) => (r.target === t.target_table ? { ...r, status: 'running' } : r)));
          const res = await mapOne(t);
          if (res.item) items.push(res.item);
          setBulkResults((prev) => prev.map((r) => (r.target === t.target_table ? res : r)));
        }
      };
      await Promise.all(Array.from({ length: Math.min(POOL, chosen.length) }, () => worker()));
      // Hold results for review — the user saves manually (see handleBulkSave).
      setBulkItems(items);
    } catch (err) {
      setTopError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkRunning(false);
    }
  }

  // Toggle a single target in/out of the bulk selection.
  function toggleTarget(name: string) {
    setSelectedTargets((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  // Toggle a source table in/out of the search set.
  function toggleSourceTable(name: string) {
    setSelectedTables((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  // Load the data preview for one bulk result row (on expand).
  async function loadBulkPreview(target: string, sql: string) {
    setBulkResults((prev) => prev.map((r) => (r.target === target ? { ...r, previewing: true } : r)));
    try {
      const res = await api.previewSql(sql);
      setBulkResults((prev) => prev.map((r) => (r.target === target
        ? { ...r, previewing: false, preview: res.error ? null : { columns: res.columns ?? [], rows: res.rows ?? [] }, previewError: res.error ?? null }
        : r)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBulkResults((prev) => prev.map((r) => (r.target === target ? { ...r, previewing: false, preview: null, previewError: msg } : r)));
    }
  }

  // Re-validate one bulk target's SQL and refresh its data preview (parity with the
  // single-target Validate button). Updates the row's status, report, and stored
  // RunItem so a subsequent save reflects the latest validation.
  async function handleBulkValidate(target: string) {
    const r = bulkResults.find((x) => x.target === target);
    const t = targetByName.get(target);
    if (!r || !t || !r.sql) return;
    setBulkResults((prev) => prev.map((x) => (x.target === target ? { ...x, validating: true, preview: null, previewError: null } : x)));
    const started = performance.now();
    try {
      const { report } = await api.validateSql(r.sql, t);
      const status: RunItem['status'] = report.status === 'SUCCESS' || report.status === 'WARNINGS' ? report.status : 'FAILED';
      setBulkResults((prev) => prev.map((x) => {
        if (x.target !== target) return x;
        const item = x.item
          ? { ...x.item, status, validationReport: report, errorMessage: report.errorMessage ?? null, durationMs: Math.round(performance.now() - started) }
          : x.item;
        return { ...x, validating: false, status: status as BulkResult['status'], error: status === 'FAILED' ? report.errorMessage ?? undefined : undefined, item };
      }));
      // Keep bulkItems (used by the grouped save) in sync with the re-validation.
      setBulkItems((prev) => prev.map((it) => (it.targetTable === target
        ? { ...it, status, validationReport: report, errorMessage: report.errorMessage ?? null }
        : it)));
      if (status === 'SUCCESS' || status === 'WARNINGS') void loadBulkPreview(target, r.sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBulkResults((prev) => prev.map((x) => (x.target === target ? { ...x, validating: false, status: 'FAILED', error: msg } : x)));
    }
  }

  // Regenerate ONE bulk target's SQL applying its per-target instructions (the current
  // SQL is fed back so the model refines it), then re-validate + refresh preview.
  async function handleBulkRegenerate(target: string) {
    const r = bulkResults.find((x) => x.target === target);
    const t = targetByName.get(target);
    if (!r || !t || !r.mappings || !(r.instructions ?? '').trim()) return;
    setBulkResults((prev) => prev.map((x) => (x.target === target ? { ...x, regenerating: true, preview: null, previewError: null } : x)));
    const started = performance.now();
    try {
      const { sources: srcs } = await api.sourceSchemas(catalog, schema, chosenTables);
      const gen = await api.generateJoinSql(endpoint, t, srcs, r.mappings, sourceSystem, {
        projectId,
        crossProject,
        sampleData, // [DATA-SAMPLING]
        sampleValues, // [DATA-SAMPLING]
        userInstructions: (r.instructions ?? '').trim(),
        priorSql: r.sql ?? undefined,
      });
      let status: RunItem['status'] = 'FAILED';
      let report = null as RunItem['validationReport'];
      let error: string | null = null;
      if (gen.readOnly) {
        const v = await api.validateSql(gen.sql, t);
        report = v.report;
        status = v.report.status === 'SUCCESS' || v.report.status === 'WARNINGS' ? v.report.status : 'FAILED';
        error = v.report.errorMessage ?? null;
      } else {
        error = gen.outputTruncated
          ? (gen.message ?? 'SQL generation hit the output token limit — raise the Prompt Sizing profile (Admin → Prompt sizing) and regenerate.')
          : 'Generated SQL is not read-only';
      }
      setBulkResults((prev) => prev.map((x) => {
        if (x.target !== target) return x;
        const item = x.item
          ? { ...x.item, generatedSql: gen.sql, status, validationReport: report, errorMessage: error, durationMs: Math.round(performance.now() - started) }
          : x.item;
        // Regenerating replaces the SQL → clear prior saved flags so it can be saved anew.
        return { ...x, regenerating: false, sql: gen.sql, item, status: status as BulkResult['status'],
          error: status === 'FAILED' ? error ?? undefined : undefined, saved: false, savedExample: false };
      }));
      setBulkItems((prev) => prev.map((it) => (it.targetTable === target
        ? { ...it, generatedSql: gen.sql, status, validationReport: report, errorMessage: error }
        : it)));
      if (status === 'SUCCESS' || status === 'WARNINGS') void loadBulkPreview(target, gen.sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBulkResults((prev) => prev.map((x) => (x.target === target ? { ...x, regenerating: false, status: 'FAILED', error: msg } : x)));
    }
  }

  // Update a bulk row's per-target instruction text.
  function setBulkInstructions(target: string, text: string) {
    setBulkResults((prev) => prev.map((x) => (x.target === target ? { ...x, instructions: text } : x)));
  }

  // Expand/collapse a bulk row; lazy-load its preview the first time it opens.
  function toggleBulkRow(target: string) {
    setBulkResults((prev) => prev.map((r) => {
      if (r.target !== target) return r;
      const nowExpanded = !r.expanded;
      if (nowExpanded && !r.preview && !r.previewError && r.sql && (r.status === 'SUCCESS' || r.status === 'WARNINGS')) {
        void loadBulkPreview(target, r.sql);
      }
      return { ...r, expanded: nowExpanded };
    }));
  }

  // Save a single bulk target to history (parity with single-target Save to History).
  async function handleBulkSaveOne(target: string) {
    const r = bulkResults.find((x) => x.target === target);
    if (!r || !r.item || !(r.status === 'SUCCESS' || r.status === 'WARNINGS')) return;
    setBulkResults((prev) => prev.map((x) => (x.target === target ? { ...x, saving: true } : x)));
    try {
      const res = await api.saveRun(crypto.randomUUID(), endpoint, [r.item]);
      setBulkResults((prev) => prev.map((x) => (x.target === target ? { ...x, saving: false, saved: true } : x)));
      setSaveMsg(`Saved ${target} (run ${res.runId.slice(0, 8)}) — submitted for review.`);
    } catch (err) {
      setBulkResults((prev) => prev.map((x) => (x.target === target ? { ...x, saving: false } : x)));
      setSaveMsg(`Save failed for ${target}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Promote a single bulk target to a reference example (editors only).
  async function handleBulkSaveExample(target: string) {
    const r = bulkResults.find((x) => x.target === target);
    if (!r || !r.sql || !(r.status === 'SUCCESS' || r.status === 'WARNINGS')) return;
    const m = r.mappings ?? [];
    const used = [...new Set(m.map((x) => x.source_table).filter((s): s is string => !!s))].sort();
    const sig = used.map((t) => `${catalog}.${schema}.${t}`).join(', ');
    const cols = m.map((x) => x.source_column).filter((c): c is string => !!c).join(' ');
    setBulkResults((prev) => prev.map((x) => (x.target === target ? { ...x, savingExample: true } : x)));
    try {
      await api.saveExample({ targetTable: target, sourceSignature: sig, sourceColumns: cols, generatedSql: r.sql, approved: true, sourceSystem, projectId });
      setBulkResults((prev) => prev.map((x) => (x.target === target ? { ...x, savingExample: false, savedExample: true } : x)));
      setSaveMsg(`Saved example for ${target}.`);
    } catch (err) {
      setBulkResults((prev) => prev.map((x) => (x.target === target ? { ...x, savingExample: false } : x)));
      setSaveMsg(`Could not save example for ${target}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Bulk targets that produced a usable mapping — the basis for group-level exports.
  function mappedBulkResults(): BulkResult[] {
    return bulkResults.filter((r) => (r.status === 'SUCCESS' || r.status === 'WARNINGS') && (r.mappings?.length ?? 0) > 0);
  }

  // Group-level Excel export: one grouped block per mapped target (same columns as
  // single-target mode), all in one .xls workbook.
  function handleBulkDownloadExcel() {
    const done = mappedBulkResults();
    if (done.length === 0) { setSaveMsg('No mapped targets to download.'); return; }
    const blocks = done.map((r) => {
      const exprByAlias = parseSelectExpressions(r.sql ?? '');
      const rowsHtml = (r.mappings ?? []).map((m) => {
        const rule = m.rationale || (m.source_table ? 'Direct mapping.' : '(no source; emit NULL cast to the target type)');
        const expr = exprByAlias.get(m.target_column.toLowerCase()) ?? (m.source_table && m.source_column ? `${m.source_table}.${m.source_column}` : 'NULL');
        return `<tr><td>${esc(m.target_column)}</td><td>${esc(m.source_table ?? '')}</td><td>${esc(m.source_column ?? '')}</td><td><code>${esc(expr)}</code></td><td>${esc(rule)}</td></tr>`;
      }).join('');
      return `<tr><td colspan="5"><b>Target Table: ${esc(r.target)}</b></td></tr>` +
        `<tr><th>Target Column</th><th>Source Table(s)</th><th>Source Column(s)</th><th>SQL Transformation</th><th>Transformation / Business Rule</th></tr>` +
        rowsHtml + `<tr><td colspan="5"></td></tr>`;
    }).join('');
    const html =
      `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">` +
      `<head><meta charset="utf-8"></head><body><table border="1">${blocks}</table></body></html>`;
    const blob = new Blob([html], { type: 'application/vnd.ms-excel' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aimapper_bulk_${schema || 'mappings'}.xls`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Group-level PDF export: a print-styled window with one section per mapped target.
  function handleBulkDownloadPdf() {
    const done = mappedBulkResults();
    if (done.length === 0) { setSaveMsg('No mapped targets to download.'); return; }
    const sections = done.map((r) => {
      const exprByAlias = parseSelectExpressions(r.sql ?? '');
      const rowsHtml = (r.mappings ?? []).map((m) => {
        const rule = m.rationale || (m.source_table ? 'Direct mapping.' : '(no source; emit NULL cast to the target type)');
        const expr = exprByAlias.get(m.target_column.toLowerCase()) ?? (m.source_table && m.source_column ? `${m.source_table}.${m.source_column}` : 'NULL');
        return `<tr><td>${esc(m.target_column)}</td><td>${esc(m.source_table ?? '')}</td><td>${esc(m.source_column ?? '')}</td><td><code>${esc(expr)}</code></td><td>${esc(rule)}</td></tr>`;
      }).join('');
      const mappedN = (r.mappings ?? []).filter((m) => m.source_table && m.source_column).length;
      return `<h2>${esc(r.target)}</h2>` +
        `<p class="sub">${mappedN}/${(r.mappings ?? []).length} target columns mapped</p>` +
        `<table><tr><th>Target Column</th><th>Source Table(s)</th><th>Source Column(s)</th><th>SQL Transformation</th><th>Transformation / Business Rule</th></tr>${rowsHtml}</table>`;
    }).join('');
    const styled = `
      <html><head><meta charset="utf-8"><title>AI Mapper — bulk (${esc(catalog)}.${esc(schema)})</title>
      <style>
        body{font-family:'DM Sans',system-ui,Arial,sans-serif;color:#1b2b32;margin:32px;}
        h1{font-size:18px;margin:0 0 4px;} h2{font-size:14px;margin:22px 0 6px;color:#c9311f;}
        .sub{color:#5e6b70;font-size:12px;margin:0 0 8px;}
        table{border-collapse:collapse;width:100%;font-size:12px;margin-bottom:6px;}
        th,td{border:1px solid #e6e2db;padding:7px 9px;text-align:left;vertical-align:top;}
        th{background:#f1efea;color:#1b2e36;font-weight:600;}
        tr:nth-child(even) td{background:#faf9f6;}
        code{font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;white-space:pre-wrap;}
        @media print{@page{margin:14mm;}}
      </style></head><body>
      <h1>AI Mapper — Bulk Mapping (${esc(catalog)}.${esc(schema)})</h1>
      <p class="sub">${done.length} target table(s)</p>
      ${sections}
      <script>window.onload=function(){window.print();}</` + `script>
      </body></html>`;
    const w = window.open('', '_blank');
    if (!w) { setSaveMsg('Enable pop-ups to download the PDF.'); return; }
    w.document.open();
    w.document.write(styled);
    w.document.close();
  }

  // Manually persist the reviewed bulk results as one grouped run. Only saves
  // items that produced usable SQL (SUCCESS / WARNINGS), matching single-target rules.
  async function handleBulkSave() {
    const savable = bulkItems.filter((it) => it.status === 'SUCCESS' || it.status === 'WARNINGS');
    if (savable.length === 0) return;
    setBulkSaving(true);
    setSaveMsg(null);
    try {
      const runId = crypto.randomUUID();
      const res = await api.saveRun(runId, endpoint, savable);
      setSaveMsg(`Saved bulk run ${res.runId.slice(0, 8)} — ${res.inserted} mapping(s) submitted for review.`);
      setBulkSaved(true);
    } catch (err) {
      setTopError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBulkSaving(false);
    }
  }

  function editMapping(idx: number, sourceTable: string | null, sourceColumn: string | null) {
    setMappings((prev) =>
      prev.map((m, i) =>
        i === idx
          ? {
              ...m,
              source_table: sourceTable,
              source_column: sourceColumn,
              confidence: sourceTable && sourceColumn ? 1 : 0,
              rationale: sourceTable && sourceColumn ? 'manual override' : '',
            }
          : m,
      ),
    );
    setRow(null);
  }

  // Feature 10 — record a 👍/👎 on a mapping pick; steers future discovery.
  const [voted, setVoted] = useState<Record<string, 'up' | 'down'>>({});
  async function handleVote(m: AttributeMapping, vote: 'up' | 'down') {
    setVoted((prev) => ({ ...prev, [m.target_column]: vote }));
    try {
      await api.sendFeedback({
        targetTable: targetEntity,
        targetColumn: m.target_column,
        sourceTable: m.source_table,
        sourceColumn: m.source_column,
        vote,
      });
    } catch {
      // non-blocking; revert the local indicator on failure
      setVoted((prev) => { const n = { ...prev }; delete n[m.target_column]; return n; });
    }
  }

  const mappedCount = mappings.filter((m) => m.source_table && m.source_column).length;

  // [DATA-SAMPLING] Estimated tokens the sample block adds — computed once per relevant
  // change instead of twice inline in the slider JSX.
  const sampleTokenEstimate = useMemo(
    () => estimateSampleTokens(sources, mappings, sampleValues),
    [sources, mappings, sampleValues],
  );

  // Generate SQL, then dry-run validate it. Non-read-only output is reported as a
  // (repairable) compile failure so the auto-repair loop can try to fix it.
  async function generateThenValidate(
    target: TargetEntity,
    opts?: { userInstructions?: string; priorSql?: string; sampleData?: boolean },
  ): Promise<{ gen: Awaited<ReturnType<typeof api.generateJoinSql>>; report: ValidationReport }> {
    // `opts` is spread last, so callers can override sampleData (the auto-repair loop
    // turns it off — samples inform format/casting, not fixing a compile error).
    const gen = await api.generateJoinSql(endpoint, target, sources, mappings, sourceSystem, { projectId, crossProject, sampleData, sampleValues, ...opts }); // [DATA-SAMPLING]
    if (!gen.readOnly) {
      return { gen, report: { status: 'FAILED', compiles: false, errorMessage: 'Generated SQL is not a read-only SELECT statement (only SELECT/JOIN is allowed).', columns: [] } };
    }
    const { report } = await api.validateSql(gen.sql, target);
    return { gen, report };
  }

  async function handleGenerate(opts?: { userInstructions?: string; priorSql?: string }) {
    const target = targetByName.get(targetEntity);
    if (!target) return;
    setGenerating(true);
    setSaveMsg(null);
    setRepairAttempt(0);
    const started = performance.now();
    try {
      let { gen, report } = await generateThenValidate(target, opts);
      // Accumulate token usage across EVERY attempt so the recorded prompt/completion
      // breakdown reconciles with the total (identify tokens are folded into total below).
      let genPromptTokens = gen.tokens?.promptTokens ?? 0;
      let genCompletionTokens = gen.tokens?.completionTokens ?? 0;
      let totalGenTokens = gen.tokens?.totalTokens ?? 0;
      // [SELF-HEAL] If the SQL didn't COMPILE, feed the exact error back to the model
      // and re-generate, up to MAX_AUTO_REPAIR times. (Schema-diff WARNINGS/FAILED that
      // DID compile are not auto-repaired — the user reviews those.) Sampling is turned
      // off on repairs: it wouldn't change (same tables) and only adds cost/PHI egress.
      for (let attempt = 1; attempt <= MAX_AUTO_REPAIR && !report.compiles && !!report.errorMessage; attempt++) {
        setRepairAttempt(attempt);
        const r = await generateThenValidate(target, {
          ...opts,
          sampleData: false,
          priorSql: gen.sql,
          userInstructions: [opts?.userInstructions, repairDirective(report.errorMessage)].filter(Boolean).join('\n\n'),
        });
        gen = r.gen;
        report = r.report;
        genPromptTokens += gen.tokens?.promptTokens ?? 0;
        genCompletionTokens += gen.tokens?.completionTokens ?? 0;
        totalGenTokens += gen.tokens?.totalTokens ?? 0;
      }
      setRepairAttempt(0);
      const base: SqlRow = {
        sql: gen.sql,
        report,
        status: report.status,
        error: report.errorMessage ?? null,
        durationMs: Math.round(performance.now() - started),
        validated: true,
        examplesUsed: gen.examplesUsed,
        referenceUsed: gen.referenceUsed ?? false,
        referenceSources: gen.referenceSources,
        savedExample: false,
        preview: null,
        previewError: null,
        promptTokens: genPromptTokens,
        completionTokens: genCompletionTokens,
        totalTokens: matchTokens + totalGenTokens,
        retrievalMethod: gen.retrievalMethod,
        selectedEndpoint: gen.selectedEndpoint,
        promptTrimmed: gen.promptTrimmed,
        examplesTruncated: gen.examplesTruncated,
      };
      setRow(base);
      setScrollTarget('sql');
      // On a successful validation, fetch a top-20 preview.
      if (report.status === 'SUCCESS' || report.status === 'WARNINGS') void loadPreview(gen.sql);
    } catch (err) {
      setRepairAttempt(0);
      setRow({ sql: row?.sql ?? '', report: null, status: 'FAILED', error: err instanceof Error ? err.message : String(err), durationMs: Math.round(performance.now() - started), validated: true, examplesUsed: 0, referenceUsed: false, savedExample: false, preview: null, previewError: null, totalTokens: 0, promptTokens: 0, completionTokens: 0 });
      setScrollTarget('sql');
    } finally {
      setGenerating(false);
    }
  }

  function onEditSql(next: string) {
    setRow((r) => (r ? { ...r, sql: next, validated: false, status: 'EDITED', report: null, error: null, savedExample: false, preview: null, previewError: null } : r));
  }

  // Copy the generated SQL to the clipboard; briefly flip the icon to a check.
  async function handleCopySql() {
    try {
      await navigator.clipboard.writeText(row?.sql ?? '');
      setSqlCopied(true);
      setTimeout(() => setSqlCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. non-secure context) — no-op.
    }
  }

  // Fetch the top-20 preview for the current SQL and store it on the row.
  async function loadPreview(sql: string) {
    setPreviewing(true);
    try {
      const res = await api.previewSql(sql);
      setRow((r) => (r ? { ...r, preview: res.error ? null : { columns: res.columns ?? [], rows: res.rows ?? [] }, previewError: res.error ?? null } : r));
    } catch (err) {
      setRow((r) => (r ? { ...r, preview: null, previewError: err instanceof Error ? err.message : String(err) } : r));
    } finally {
      setPreviewing(false);
    }
  }

  async function handleValidate() {
    const target = targetByName.get(targetEntity);
    if (!target || !row) return;
    setValidating(true);
    const started = performance.now();
    try {
      const { report } = await api.validateSql(row.sql, target);
      setRow({ ...row, report, status: report.status, error: report.errorMessage ?? null, validated: true, durationMs: Math.round(performance.now() - started), preview: null, previewError: null });
      if (report.status === 'SUCCESS' || report.status === 'WARNINGS') void loadPreview(row.sql);
    } catch (err) {
      setRow({ ...row, status: 'FAILED', error: err instanceof Error ? err.message : String(err), validated: true });
    } finally {
      setValidating(false);
    }
  }

  // Mapping rows shared by the Excel + PDF exports, grouped by target table:
  // Target Column | Source Table(s) | Source Column(s) | SQL Transformation | Rule.
  // The SQL Transformation is the ACTUAL per-column expression parsed from the
  // generated SELECT (keyed by the target alias), so the export is executable, not
  // just descriptive. Falls back to the plain source ref / NULL when unavailable.
  function mappingRowsHtml(esc: (s: string) => string): string {
    const exprByAlias = parseSelectExpressions(row?.sql ?? '');
    return mappings
      .map((m) => {
        const rule = m.rationale || (m.source_table ? 'Direct mapping.' : '(no source; emit NULL cast to the target type)');
        const expr = exprByAlias.get(m.target_column.toLowerCase())
          ?? (m.source_table && m.source_column ? `${m.source_table}.${m.source_column}` : 'NULL');
        return `<tr><td>${esc(m.target_column)}</td><td>${esc(m.source_table ?? '')}</td><td>${esc(m.source_column ?? '')}</td><td><code>${esc(expr)}</code></td><td>${esc(rule)}</td></tr>`;
      })
      .join('');
  }

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Excel: an HTML-table workbook (.xls) — no dependency; Excel/Sheets open it natively.
  function handleDownloadExcel() {
    const html =
      `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">` +
      `<head><meta charset="utf-8"></head><body><table border="1">` +
      `<tr><td colspan="5"><b>Target Table: ${esc(targetEntity)}</b></td></tr>` +
      `<tr><th>Target Column</th><th>Source Table(s)</th><th>Source Column(s)</th><th>SQL Transformation</th><th>Transformation / Business Rule</th></tr>` +
      `${mappingRowsHtml(esc)}</table></body></html>`;
    const blob = new Blob([html], { type: 'application/vnd.ms-excel' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aimapper_${targetEntity || 'mapping'}.xls`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // PDF: open a print-styled window and trigger the browser's print dialog
  // (user picks "Save as PDF"). No dependency; keeps the same grouped layout.
  function handleDownloadPdf() {
    const styled = `
      <html><head><meta charset="utf-8"><title>AI Mapper — ${esc(targetEntity)}</title>
      <style>
        body{font-family:'DM Sans',system-ui,Arial,sans-serif;color:#1b2b32;margin:32px;}
        h1{font-size:18px;margin:0 0 4px;}
        .sub{color:#5e6b70;font-size:12px;margin:0 0 18px;}
        table{border-collapse:collapse;width:100%;font-size:12px;}
        th,td{border:1px solid #e6e2db;padding:7px 9px;text-align:left;vertical-align:top;}
        th{background:#f1efea;color:#1b2e36;font-weight:600;}
        tr:nth-child(even) td{background:#faf9f6;}
        code{font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;white-space:pre-wrap;}
        @media print{@page{margin:14mm;}}
      </style></head><body>
      <h1>AI Mapper — Target Table: ${esc(targetEntity)}</h1>
      <p class="sub">${mappings.filter((m) => m.source_table && m.source_column).length}/${mappings.length} target columns mapped</p>
      <table>
        <tr><th>Target Column</th><th>Source Table(s)</th><th>Source Column(s)</th><th>SQL Transformation</th><th>Transformation / Business Rule</th></tr>
        ${mappingRowsHtml(esc)}
      </table>
      <script>window.onload=function(){window.print();}</` + `script>
      </body></html>`;
    const w = window.open('', '_blank');
    if (!w) {
      setSaveMsg('Enable pop-ups to download the PDF.');
      return;
    }
    w.document.open();
    w.document.write(styled);
    w.document.close();
  }

  // An inspected (read-only, loaded-from-history) row is never savable — validating
  // it must not re-enable Save to History / Save as Example (no duplicates/versions
  // from a pure inspection). Regenerating produces a fresh, non-inspected row.
  const savable = Boolean(row?.validated && !row.inspected && (row.status === 'SUCCESS' || row.status === 'WARNINGS'));

  async function handleSaveHistory() {
    if (!row || !savable) return;
    setSaving(true);
    const used = [...new Set(mappings.map((m) => m.source_table).filter((t): t is string => !!t))].sort();
    const runId = crypto.randomUUID();
    const item: RunItem = {
      itemId: crypto.randomUUID(),
      sourceCatalog: catalog,
      sourceSchema: schema,
      sourceTable: used.join(', ') || '(none)',
      targetTable: targetEntity,
      matchMethod: 'attribute_discovery',
      matchConfidence: meanConfidence(mappings),
      matchRationale: `${mappedCount}/${mappings.length} attributes mapped across ${used.length} table(s)`,
      generatedSql: row.sql,
      status: row.status === 'PENDING' || row.status === 'EDITED' ? 'FAILED' : row.status,
      validationReport: row.report,
      errorMessage: row.error,
      durationMs: row.durationMs,
      mappingsJson: JSON.stringify(mappings),
      sourceSystem,
      projectId,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.totalTokens,
    };
    try {
      const res = await api.saveRun(runId, endpoint, [item]);
      setRow((r) => (r ? { ...r, savedHistory: true } : r));
      setSaveMsg(`Saved run ${res.runId.slice(0, 8)} — ${res.inserted} mapping(s) submitted for review.`);
    } catch (err) {
      setSaveMsg(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveExample() {
    if (!row || !savable) return;
    setSavingExample(true);
    const used = [...new Set(mappings.map((m) => m.source_table).filter((t): t is string => !!t))].sort();
    const sig = used.map((t) => `${catalog}.${schema}.${t}`).join(', ');
    const cols = mappings.map((m) => m.source_column).filter((c): c is string => !!c).join(' ');
    try {
      await api.saveExample({ targetTable: targetEntity, sourceSignature: sig, sourceColumns: cols, generatedSql: row.sql, approved: true, sourceSystem, projectId });
      setRow((r) => (r ? { ...r, savedExample: true } : r));
      setSaveMsg(`Saved example for ${targetEntity}.`);
    } catch (err) {
      setSaveMsg(`Could not save example: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingExample(false);
    }
  }

  // Read-only progress for the stepper — derived purely from existing state.
  const currentStep: 1 | 2 | 3 | 4 = !projectId
    ? 1
    : bulkMode
    ? (bulkResults.length > 0 ? 4 : 2)
    : row
    ? 4
    : mappings.length > 0 || matchError
    ? 3
    : 2;

  return (
    <div className="space-y-6 w-full max-w-6xl mx-auto">
      <PageHeader
        eyebrow={currentProject ? <>Workspace <span className="mx-0.5 text-muted-foreground/60">/</span> {currentProject.name}</> : 'Workspace'}
        title="Mapper"
        description="Pick a source catalog & schema and a target entity. The LLM discovers which source attributes (across any tables) map to each target column, then writes one JOIN SQL statement."
      />

      <MapperStepper current={currentStep} />

      {topError && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{topError}</AlertDescription>
        </Alert>
      )}
      {reloadNote && (
        <Alert>
          <History className="h-4 w-4" />
          <AlertTitle>Reloaded from history</AlertTitle>
          <AlertDescription>{reloadNote}</AlertDescription>
        </Alert>
      )}

      {/* 01 Project — select which project to map in; its source system, vendor, and
          schema version drive the flow. Projects are created/managed on the Projects page. */}
      <Panel className="p-6 space-y-5 scroll-mt-6" >
        <div id="mapper-step-1" className="scroll-mt-6">
          <StepHeading
            index="01"
            title="Project"
            description={<>Its schema version drives every target reference below. Create &amp; manage projects on the <span className="font-semibold text-foreground">Projects</span> page.</>}
          />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4 items-end">
          <div className="space-y-1.5 min-w-0">
            <Label className="text-[0.8125rem] font-semibold">Project</Label>
            <SearchableSelect
              value={projectId}
              onValueChange={setProjectId}
              disabled={loadingLists || !projects.length}
              className="w-full"
              placeholder="Select project"
              options={projects.map((p) => ({ value: p.project_id, label: p.name }))}
            />
          </div>

          {/* Project details as a sunken strip of labelled fields. */}
          <dl className="grid grid-cols-2 sm:grid-cols-4 rounded-[0.625rem] bg-surface-sunken divide-x divide-border overflow-hidden">
            <ProjectField label="Source system" value={sourceSystem} />
            <ProjectField
              label="Vendor"
              value={currentProject?.vendor_name ? `${currentProject.vendor_name} (${currentProject.vendor_code})` : '—'}
            />
            <ProjectField label="Schema version" value={currentProject?.schema_version_label || '—'} />
            <ProjectField label="Description" value={currentProject?.description || '—'} muted />
          </dl>
        </div>

        {/* Cross-Project Learning toggle — a tinted callout row. */}
        <label className="flex items-center gap-3 rounded-[0.625rem] bg-surface-sunken px-4 py-3 cursor-pointer">
          <Checkbox checked={crossProject} onCheckedChange={(v) => setCrossProject(v === true)} className="shrink-0" />
          <span className="text-[0.8125rem] text-muted-foreground min-w-0">
            <span className="font-semibold text-foreground">Cross-project learning</span> — also use other {sourceSystem} projects&apos; approved mappings &amp; history. Off = this project only.
          </span>
        </label>
      </Panel>

      {/* 02 Source & target */}
      <Panel className="p-6 space-y-5">
        <div id="mapper-step-2" className="scroll-mt-6">
          <StepHeading
            index="02"
            title="Source & target"
            description="Source catalog → schema (scoped to your permissions), the target entity, and an LLM endpoint."
            actions={
              <div className="inline-flex rounded-[0.625rem] bg-surface-sunken p-1">
                <button
                  type="button"
                  onClick={() => setBulkMode(false)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${!bulkMode ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  Single target
                </button>
                <button
                  type="button"
                  onClick={() => setBulkMode(true)}
                  className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${bulkMode ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  <Layers className="h-3.5 w-3.5" /> All targets
                </button>
              </div>
            }
          />
        </div>

        {/* Source catalog → schema → tables (the "where to read from" row). */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1.5 min-w-0">
            <Label className="text-[0.8125rem] font-semibold">Source catalog</Label>
            <SearchableSelect
              value={catalog}
              onValueChange={setCatalog}
              disabled={loadingLists}
              className="w-full"
              placeholder="Select catalog"
              options={catalogs.map((c) => ({ value: c, label: c }))}
            />
          </div>
          <div className="space-y-1.5 min-w-0">
            <Label className="text-[0.8125rem] font-semibold">Source schema</Label>
            <SearchableSelect
              value={schema}
              onValueChange={setSchema}
              disabled={!catalog}
              className="w-full"
              placeholder="Select schema"
              options={schemas.map((s) => ({ value: s, label: s }))}
            />
          </div>
          {/* Source tables multi-select (all selected by default; deselect to narrow). */}
          <div className="space-y-1.5 min-w-0">
            <Label className="text-[0.8125rem] font-semibold">Source tables</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild disabled={!tables.length}>
                <Button variant="outline" className="h-10 w-full justify-between font-normal">
                  <span className="truncate">
                    {!tables.length
                      ? 'Select a schema first'
                      : selectedTables.size === 0
                      ? 'Select source tables'
                      : selectedTables.size === tables.length
                      ? `All ${tables.length} tables`
                      : `${selectedTables.size} of ${tables.length} selected`}
                  </span>
                  <ChevronDown className="h-4 w-4 ml-1.5 opacity-50 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72 max-h-80 overflow-y-auto">
                <div className="flex items-center justify-between px-2 py-1.5">
                  <DropdownMenuLabel className="p-0">Tables to search</DropdownMenuLabel>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" className="h-6 text-xs px-1.5" onClick={() => setSelectedTables(new Set(tables))}>All</Button>
                    <Button variant="ghost" size="sm" className="h-6 text-xs px-1.5" onClick={() => setSelectedTables(new Set())}>None</Button>
                  </div>
                </div>
                <DropdownMenuSeparator />
                {tables.map((t) => (
                  <DropdownMenuItem
                    key={t}
                    className="gap-2"
                    onSelect={(e) => e.preventDefault()}
                    onClick={() => toggleSourceTable(t)}
                  >
                    <Checkbox checked={selectedTables.has(t)} className="pointer-events-none" />
                    <span className="truncate font-mono text-xs" title={t}>{t}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Target entity → LLM endpoint (the "what to produce / with which model" row). */}
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4">
          <div className="space-y-1.5 min-w-0">
            <Label className="text-[0.8125rem] font-semibold">Target entity</Label>
            {bulkMode ? (
              // Multi-select: pick/deselect which targets the bulk run maps.
              <DropdownMenu>
                <DropdownMenuTrigger asChild disabled={!targetNames.length || bulkRunning}>
                  <Button variant="outline" className="h-10 w-full justify-between font-normal">
                    <span className="truncate">
                      {selectedTargets.size === 0
                        ? 'Select targets'
                        : selectedTargets.size === targetNames.length
                        ? `All ${targetNames.length} targets`
                        : `${selectedTargets.size} of ${targetNames.length} selected`}
                    </span>
                    <ChevronDown className="h-4 w-4 ml-1.5 opacity-50 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64 max-h-80 overflow-y-auto">
                  <div className="flex items-center justify-between px-2 py-1.5">
                    <DropdownMenuLabel className="p-0">Targets to map</DropdownMenuLabel>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" className="h-6 text-xs px-1.5" onClick={() => setSelectedTargets(new Set(targetNames))}>All</Button>
                      <Button variant="ghost" size="sm" className="h-6 text-xs px-1.5" onClick={() => setSelectedTargets(new Set())}>None</Button>
                    </div>
                  </div>
                  <DropdownMenuSeparator />
                  {targetNames.map((n) => (
                    <DropdownMenuItem
                      key={n}
                      className="gap-2"
                      onSelect={(e) => e.preventDefault()}
                      onClick={() => toggleTarget(n)}
                    >
                      <Checkbox checked={selectedTargets.has(n)} className="pointer-events-none" />
                      <span className="truncate font-mono text-xs" title={n}>{n}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <SearchableSelect
                value={targetEntity}
                onValueChange={setTargetEntity}
                disabled={!targetNames.length}
                className="w-full"
                placeholder="Select target"
                options={targetNames.map((n) => ({ value: n, label: n }))}
              />
            )}
          </div>
          <div className="space-y-1.5 min-w-0">
            <Label className="text-[0.8125rem] font-semibold">LLM endpoint</Label>
            <SearchableSelect
              value={endpoint}
              onValueChange={setEndpoint}
              className="w-full"
              placeholder="Select endpoint"
              options={[
                ...(autoModelSelect ? [{ value: 'auto', label: 'Auto (by task size)' }] : []),
                ...endpoints.map((e) => ({ value: e, label: e })),
              ]}
            />
          </div>
        </div>

        {/* Source-table search scope caption. */}
        {catalog && schema && tables.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {selectedTables.size === 0
              ? 'Select at least one source table to search.'
              : <>Searching <span className="font-semibold text-foreground">{selectedTables.size}</span> of {tables.length} table(s) in <span className="font-mono">{catalog}.{schema}</span> for matching attributes.</>}
            {selectedTables.size > LARGE_SELECTION_WARN && (
              <span className="block mt-1 text-warning-soft-foreground">
                Large selection: discovery will pre-filter to the {LARGE_SELECTION_WARN} most relevant tables per target. Select fewer tables for more precise matching.
              </span>
            )}
          </p>
        )}

        {/* [DATA-SAMPLING] Per-run toggle + sample-size slider. Remove this whole block to drop the UI control. */}
        <div className="rounded-[0.625rem] border border-warning/40 bg-warning-soft px-4 py-3 space-y-2">
          <label className="flex items-start gap-3 cursor-pointer">
            <Checkbox checked={sampleData} onCheckedChange={(v) => setSampleData(v === true)} className="shrink-0 mt-0.5 bg-card" />
            <span className="text-[0.8125rem] text-foreground">
              <span className="font-semibold">Sample source data</span> — send a few real example values per source column to the model to sharpen casting &amp; format detection.
              <span className="block text-xs text-warning-soft-foreground mt-0.5">Sends actual source data (including PHI) to the LLM endpoint and costs more tokens. Samples are not stored.</span>
            </span>
          </label>
          {sampleData && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-7 pt-1">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="text-xs text-muted-foreground shrink-0">Sample size</span>
                <Slider
                  value={[sampleValues]}
                  min={MIN_SAMPLE_VALUES}
                  max={MAX_SAMPLE_VALUES}
                  step={1}
                  onValueChange={(v) => setSampleValues(v[0] ?? DEFAULT_SAMPLE_VALUES)}
                  className="max-w-44"
                />
                <span className="text-xs font-semibold text-foreground tabular-nums shrink-0">
                  {sampleValues} {sampleValues === 1 ? 'value' : 'values'}/col
                  {sampleValues === DEFAULT_SAMPLE_VALUES && <span className="font-normal text-muted-foreground"> (default)</span>}
                </span>
              </div>
              {/* Live token impact, side by side — updates as the slider moves. */}
              <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                {sampleTokenEstimate > 0
                  ? `≈ +${sampleTokenEstimate.toLocaleString()} tokens/generate`
                  : 'select sources for a token estimate'}
              </span>
            </div>
          )}
        </div>

        {bulkMode ? (
          <Button
            onClick={() => void handleBulkRun()}
            disabled={!catalog || !schema || !endpoint || selectedTables.size === 0 || selectedTargets.size === 0 || bulkRunning}
          >
            <Layers className="h-4 w-4 mr-1.5" /> {bulkRunning ? `Mapping ${selectedTargets.size} Target(s)…` : `Map ${selectedTargets.size} Target${selectedTargets.size === 1 ? '' : 's'}`}
          </Button>
        ) : (
          <Button onClick={() => void handleIdentify()} disabled={!ready || identifying}>
            <Search className="h-4 w-4 mr-1.5" /> {identifying ? 'Identifying mappings…' : 'Identify mappings'}
          </Button>
        )}
      </Panel>

      {/* Bulk run results */}
      {bulkMode && bulkResults.length > 0 && (
        <Panel className="p-6 space-y-5">
          <div id="mapper-step-3" className="scroll-mt-6">
            <StepHeading
              index="03"
              title="Bulk mapping results"
              description={
                <>
                  <span className="font-semibold text-foreground">{bulkResults.filter((r) => r.status === 'SUCCESS' || r.status === 'WARNINGS').length}/{bulkResults.length}</span> targets mapped.
                  {' '}Expand a row to see its SQL and data preview. Save targets individually, or all at once below — nothing is saved automatically.
                </>
              }
            />
          </div>
          <div className="divide-y divide-border border rounded-xl overflow-hidden">
            {bulkResults.map((r) => (
              <BulkResultRow
                key={r.target}
                r={r}
                isEditor={isEditor}
                onToggle={() => toggleBulkRow(r.target)}
                onValidate={() => void handleBulkValidate(r.target)}
                onSave={() => void handleBulkSaveOne(r.target)}
                onSaveExample={() => void handleBulkSaveExample(r.target)}
                onInstructions={(text) => setBulkInstructions(r.target, text)}
                onRegenerate={() => void handleBulkRegenerate(r.target)}
              />
            ))}
          </div>
          {!bulkRunning && bulkItems.length > 0 && (
            <div className="flex items-center gap-3 flex-wrap border-t pt-4">
              {(() => {
                const savableN = bulkItems.filter((it) => it.status === 'SUCCESS' || it.status === 'WARNINGS').length;
                return (
                  <>
                    <Button onClick={() => void handleBulkSave()} disabled={savableN === 0 || bulkSaving || bulkSaved}>
                      <Save className="h-4 w-4 mr-1.5" /> {bulkSaving ? 'Submitting…' : bulkSaved ? 'Submitted for review' : `Submit ${savableN} for review`}
                    </Button>
                    {savableN === 0 && <p className="text-xs text-muted-foreground">No successful mappings to save.</p>}
                    {savableN > 0 && !bulkSaved && <p className="text-xs text-muted-foreground">Saves the {savableN} SUCCESS/WARNINGS mapping(s) to History as one run.</p>}
                    {savableN > 0 && (
                      <div className="ml-auto">
                        <DownloadMenu onExcel={handleBulkDownloadExcel} onPdf={handleBulkDownloadPdf} iconOnly />
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}
          {saveMsg && <p className="text-xs text-muted-foreground">{saveMsg}</p>}
        </Panel>
      )}

      {!bulkMode && (mappings.length > 0 || matchError) && (
        <div ref={mappingsSectionRef} id="mapper-step-3" className="scroll-mt-6">
        <Panel className="p-6 space-y-5">
          <StepHeading
            index="03"
            title={<>Attribute mappings for <Mono className="text-[1.0625rem] font-bold">{targetEntity}</Mono></>}
            description="Override the source table or column, or clear it. Thumbs up / down confirms or rejects a pick — your feedback steers future discovery for this target."
            actions={
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-success" /> ≥ 80%</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-warning" /> Low confidence</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-brand" /> No match</span>
              </div>
            }
          />
          {matchError && (
            <Alert variant="destructive">
              <AlertTitle>Attribute matching failed</AlertTitle>
              <AlertDescription>{matchError}</AlertDescription>
            </Alert>
          )}
          {matchWarning && (
            <Alert>
              <AlertTitle>⚠ Matching response truncated</AlertTitle>
              <AlertDescription>{matchWarning}</AlertDescription>
            </Alert>
          )}
          {mappings.length > 0 && (
            <>
              <SearchField value={gridFilter} onChange={setGridFilter} placeholder="Filter columns…" className="max-w-sm" />
              <div className="-mx-6 border-y border-border">
                <MappingGrid mappings={mappings} sources={sources} onEdit={editMapping} filter={gridFilter} voted={voted} onVote={(m, v) => void handleVote(m, v)} />
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <Button onClick={() => void handleGenerate({ userInstructions: userInstructions.trim() || undefined })} disabled={generating}>
                  <Sparkles className="h-4 w-4 mr-1.5" /> {repairAttempt > 0 ? `Auto-fixing SQL (${repairAttempt}/${MAX_AUTO_REPAIR})…` : generating ? 'Generating SQL…' : 'Generate SQL'}
                </Button>
                <p className="text-[0.8125rem] text-muted-foreground"><span className="font-semibold text-foreground tabular-nums">{mappedCount} / {mappings.length}</span> target columns mapped</p>
              </div>
            </>
          )}
        </Panel>
        </div>
      )}

      {!bulkMode && row && (
        <div ref={sqlSectionRef} id="mapper-step-4" className="scroll-mt-6">
        <Panel className="p-6 space-y-5">
          <StepHeading
            index="04"
            title="Generated mapping SQL"
            actions={<StatusPill tone={statusTone(row.status)}>{statusLabel(row.status)}</StatusPill>}
          />

          {/* Retrieval / model / grounding / token info as a row of meta chips. */}
          <div className="flex flex-wrap gap-2 -mt-2">
            {row.examplesUsed > 0 && (
              <MetaChip title={`Guided by ${row.examplesUsed} reference example(s) for ${targetEntity}, retrieved via ${row.retrievalMethod === 'vector_search' ? 'semantic Vector Search' : 'lexical matching'}.`}>
                {row.examplesUsed} reference example{row.examplesUsed === 1 ? '' : 's'} · {row.retrievalMethod === 'vector_search' ? 'Vector Search' : 'lexical matching'}
              </MetaChip>
            )}
            {row.examplesUsed === 0 && row.retrievalMethod && (
              <MetaChip>No prior examples matched · {row.retrievalMethod === 'vector_search' ? 'Vector Search' : 'lexical'} retrieval</MetaChip>
            )}
            {row.selectedEndpoint && (
              <MetaChip title="Model auto-selected by task size">{row.selectedEndpoint} · auto-selected</MetaChip>
            )}
            {row.referenceUsed && (() => {
              const g = groundingChip(row.referenceSources, `Grounded in reference documents for ${targetEntity}`);
              return <MetaChip title={g.title}>{g.text}</MetaChip>;
            })()}
            {row.promptTrimmed && <MetaChip title="Prompt was large — trimmed data samples/examples to fit the model context.">Prompt trimmed to fit context</MetaChip>}
            {!!row.examplesTruncated && row.examplesTruncated > 0 && (
              <MetaChip tone="warning">
                {row.examplesTruncated} reference example(s) exceeded the size cap and were truncated — the model saw only their leading portion
              </MetaChip>
            )}
            {row.totalTokens > 0 && (
              <MetaChip>
                {row.totalTokens.toLocaleString()} tokens this task
                {row.promptTokens > 0 && ` · ${row.promptTokens.toLocaleString()} in / ${row.completionTokens.toLocaleString()} out + identify`}
              </MetaChip>
            )}
          </div>

          <div className="relative">
            <Textarea
              value={row.sql}
              onChange={(e) => onEditSql(e.target.value)}
              spellCheck={false}
              className="font-mono text-xs leading-relaxed h-72 pr-12 p-4 rounded-xl! bg-ink! text-ink-foreground! border-transparent! focus-visible:ring-2 focus-visible:ring-brand/50"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => void handleCopySql()}
              className="absolute! top-3 right-3 z-10 h-8 w-8 bg-white/10 ring-1 ring-white/15 hover:bg-white/20 text-white hover:text-white"
              title={sqlCopied ? 'Copied!' : 'Copy SQL to clipboard'}
            >
              {sqlCopied ? <Check className="h-4 w-4 text-success-soft-foreground" /> : <Copy className="h-4 w-4 text-ink-muted" />}
            </Button>
          </div>

          {/* Per-run instruction box: refine THIS mapping with a natural-language tweak,
              then regenerate (the current SQL is fed back so the model edits it). */}
          <RefineBox
            value={userInstructions}
            onChange={setUserInstructions}
            scopeNote="optional, applies to this mapping only"
            placeholder="e.g. Cast all amount columns to DECIMAL(18,2). Prefer patient_master over patient_staging. Trim whitespace on IDs."
            action={
              <Button
                variant="outline"
                onClick={() => void handleGenerate({ userInstructions: userInstructions.trim() || undefined, priorSql: row.sql })}
                disabled={generating || !userInstructions.trim()}
                title="Regenerate the SQL applying these instructions to the current statement"
              >
                <Sparkles className="h-4 w-4 mr-1.5" /> {repairAttempt > 0 ? `Auto-fixing SQL (${repairAttempt}/${MAX_AUTO_REPAIR})…` : generating ? 'Regenerating…' : 'Regenerate with instructions'}
              </Button>
            }
          />

          <div className="flex items-center gap-2 flex-wrap">
            <Button onClick={() => void handleValidate()} disabled={validating}>
              <CheckCircle2 className="h-4 w-4 mr-1.5" /> {validating ? 'Validating…' : 'Validate'}
            </Button>
            <Button variant="outline" onClick={() => void handleSaveHistory()} disabled={!savable || saving || savingExample || row.savedHistory}>
              <Save className="h-4 w-4 mr-1.5" /> {saving ? 'Submitting…' : row.savedHistory ? 'Submitted for review' : 'Submit for review'}
            </Button>
            {isEditor && (
              <Button variant="outline" onClick={() => void handleSaveExample()} disabled={!savable || saving || savingExample || row.savedExample}>
                <Star className="h-4 w-4 mr-1.5" /> {savingExample ? 'Saving…' : row.savedExample ? 'Saved as example' : 'Save as example'}
              </Button>
            )}
            {row.inspected && <p className="text-xs text-muted-foreground">Read-only inspection from history — saving is disabled. Regenerate the mapping to create a new version.</p>}
            {!row.inspected && row.status === 'EDITED' && <p className="text-xs text-muted-foreground">Edited — click Validate to re-check before saving.</p>}
            {!row.inspected && !savable && row.status !== 'EDITED' && <p className="text-xs text-muted-foreground">Validate successfully (SUCCESS/WARNINGS) to enable saving.</p>}
            {/* Download mapping (Excel/PDF) as an icon, pushed to the far right. */}
            <div className="ml-auto">
              <DownloadMenu onExcel={handleDownloadExcel} onPdf={handleDownloadPdf} iconOnly />
            </div>
          </div>
          {row.validated && row.status === 'SUCCESS' && (
            <div className="flex items-start gap-2.5 rounded-[0.625rem] bg-success-soft px-4 py-3 text-[0.8125rem] text-success-soft-foreground">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              <p><span className="font-semibold">Validation successful.</span> The generated SQL matches the target schema.</p>
            </div>
          )}
          {row.error && <p className="text-xs text-destructive">{row.error}</p>}
          {/* [SELF-HEAL] Manual repair for a compile failure — feeds the error back to the model. */}
          {!row.inspected && row.status === 'FAILED' && !!row.error && row.report && !row.report.compiles && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleGenerate({ priorSql: row.sql, userInstructions: repairDirective(row.error ?? '') })}
              disabled={generating}
              title="Send this SQL and its compile error back to the model to fix"
            >
              <Wrench className="h-4 w-4 mr-1.5" /> {generating ? 'Fixing…' : 'Fix with AI'}
            </Button>
          )}
          {row.report && <ValidationSummary report={row.report} />}

          {/* Feature 7 — column-level lineage from the current mappings. */}
          {mappings.length > 0 && (
            <div className="space-y-3 border-t pt-4">
              <button
                type="button"
                onClick={() => setShowLineage((s) => !s)}
                className="flex items-center gap-1.5 text-sm font-semibold text-foreground hover:text-brand transition-colors"
              >
                <GitBranch className="h-4 w-4 text-muted-foreground" /> Column lineage
                <ChevronDown className={`h-4 w-4 transition-transform ${showLineage ? '' : '-rotate-90'}`} />
              </button>
              {showLineage && <ColumnLineageGraph sources={sources} mappings={mappings} targetTable={targetEntity} />}
            </div>
          )}

          {(previewing || row.preview || row.previewError) && (
            <PreviewPanel
              meta={row.preview && row.preview.columns.length > 0
                ? `${row.preview.rows.length} row${row.preview.rows.length === 1 ? '' : 's'} · ${row.preview.columns.length} col${row.preview.columns.length === 1 ? '' : 's'}`
                : null}
            >
              {previewing && <p className="text-xs text-muted-foreground px-4 py-3">Running preview…</p>}
              {row.previewError && <p className="text-xs text-destructive px-4 py-3">Preview failed: {row.previewError}</p>}
              {row.preview && <PreviewTable preview={row.preview} />}
            </PreviewPanel>
          )}

          {saveMsg && <p className="text-xs text-muted-foreground">{saveMsg}</p>}
        </Panel>
        </div>
      )}
    </div>
  );
}

// ── Presentational helpers (layout only) ─────────────────────────────────────

const MAPPER_STEPS: { n: 1 | 2 | 3 | 4; label: string }[] = [
  { n: 1, label: 'Project' },
  { n: 2, label: 'Source & target' },
  { n: 3, label: 'Attribute mappings' },
  { n: 4, label: 'SQL & validate' },
];

/** Horizontal 4-step progress indicator. Read-only: highlights the current step and
 * scrolls to a section when clicked (no state changes). */
function MapperStepper({ current }: { current: 1 | 2 | 3 | 4 }) {
  const jump = (n: number) => document.getElementById(`mapper-step-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <nav aria-label="Mapping progress" className="grid grid-cols-2 md:grid-cols-4 gap-1.5 rounded-[var(--radius)] border bg-card p-1.5">
      {MAPPER_STEPS.map((s) => {
        const isCurrent = s.n === current;
        const isDone = s.n < current;
        return (
          <button
            key={s.n}
            type="button"
            onClick={() => jump(s.n)}
            aria-current={isCurrent ? 'step' : undefined}
            className={`flex items-center gap-2.5 rounded-[0.625rem] px-3 py-2 text-left text-[0.8125rem] font-semibold transition-colors ${
              isCurrent ? 'bg-brand-soft text-brand-soft-foreground' : 'text-foreground hover:bg-muted'
            }`}
          >
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-bold ${
                isCurrent ? 'bg-brand text-white' : isDone ? 'bg-ink text-ink-foreground' : 'bg-muted text-muted-foreground'
              }`}
            >
              {isDone ? <Check className="h-3.5 w-3.5" /> : s.n}
            </span>
            <span className="truncate">{s.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** One labelled field in the project-details strip. */
function ProjectField({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="min-w-0 px-4 py-2.5">
      <dt className="text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 text-sm truncate ${muted ? 'text-foreground/80' : 'font-semibold text-foreground'}`} title={value}>{value}</dd>
    </div>
  );
}

/** Small rounded meta chip (retrieval, endpoint, tokens …). */
/** "Grounded in 6 passages · Epic_PATIENT.pdf, Epic_COVERAGE…" with a per-passage tooltip. */
function groundingChip(sources: ReferenceSource[] | undefined, fallback: string): { text: string; title?: string } {
  if (!sources || sources.length === 0) return { text: fallback };
  const files = [...new Set(sources.map((s) => s.file))];
  const shown = files.slice(0, 2).join(', ') + (files.length > 2 ? ` +${files.length - 2}` : '');
  const title = sources
    .map((s) => `${s.file}${s.pages ? ` p.${s.pages}` : ''}${s.heading ? ` · ${s.heading}` : ''} (score ${s.score})`)
    .join('\n');
  return { text: `Grounded in ${sources.length} passage${sources.length === 1 ? '' : 's'} · ${shown}`, title };
}

function MetaChip({ children, title, tone }: { children: ReactNode; title?: string; tone?: 'warning' }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[0.6875rem] font-semibold ${
        tone === 'warning' ? 'bg-warning-soft text-warning-soft-foreground' : 'bg-muted text-foreground/80'
      }`}
    >
      {children}
    </span>
  );
}

/** "Refine with instructions" box shared by single-target and bulk rows. */
function RefineBox({
  value,
  onChange,
  scopeNote,
  placeholder,
  action,
}: {
  value: string;
  onChange: (text: string) => void;
  scopeNote: ReactNode;
  placeholder: string;
  action: ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card p-4 space-y-2.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Wand2 className="h-4 w-4 text-brand" />
        <Label className="text-[0.8125rem] font-semibold">Refine with instructions</Label>
        <span className="text-xs text-muted-foreground">· {scopeNote}</span>
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="text-sm h-20 bg-surface-sunken! text-foreground"
        maxLength={4000}
      />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="text-xs text-muted-foreground tabular-nums">{value.length.toLocaleString()} / 4,000</span>
        {action}
      </div>
    </div>
  );
}

/** Bordered data-preview panel with a sunken header strip. */
function PreviewPanel({ meta, children, compact }: { meta: string | null; children: ReactNode; compact?: boolean }) {
  return (
    <div className="rounded-xl border overflow-hidden bg-card">
      <div className={`flex items-center justify-between gap-3 px-4 ${compact ? 'py-2' : 'py-2.5'} bg-surface-sunken border-b`}>
        <span className="flex items-center gap-1.5 text-[0.8125rem] font-semibold text-foreground">
          <TableProperties className="h-4 w-4 text-muted-foreground" /> Data preview
          <span className="font-normal text-muted-foreground">· live sample from the generated SQL</span>
        </span>
        {meta && <span className="text-xs text-muted-foreground tabular-nums">{meta}</span>}
      </div>
      {children}
    </div>
  );
}

function BulkStatusBadge({ status }: { status: BulkResult['status'] }) {
  if (status === 'pending') return <StatusPill tone="neutral">Queued</StatusPill>;
  if (status === 'running') return <StatusPill tone="brand">Running…</StatusPill>;
  if (status === 'SUCCESS') return <StatusPill tone="success">Success</StatusPill>;
  if (status === 'WARNINGS') return <StatusPill tone="warning">Warnings</StatusPill>;
  return <StatusPill tone="danger">Failed</StatusPill>;
}

// One bulk-run result row: a summary line that expands to the full per-target detail
// (SQL, retrieval/token info, data preview, and per-target save actions) — parity
// with single-target mode.
function BulkResultRow({
  r,
  isEditor,
  onToggle,
  onValidate,
  onSave,
  onSaveExample,
  onInstructions,
  onRegenerate,
}: {
  r: BulkResult;
  isEditor: boolean;
  onToggle: () => void;
  onValidate: () => void;
  onSave: () => void;
  onSaveExample: () => void;
  onInstructions: (text: string) => void;
  onRegenerate: () => void;
}) {
  const done = r.status === 'SUCCESS' || r.status === 'WARNINGS';
  const expandable = done || r.status === 'FAILED';
  return (
    <div>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={expandable ? onToggle : undefined}
          className={`flex items-center gap-2 text-sm font-semibold min-w-0 ${expandable ? 'hover:text-brand cursor-pointer' : 'cursor-default'}`}
          disabled={!expandable}
        >
          {expandable && (
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-input">
              <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${r.expanded ? '' : '-rotate-90'}`} />
            </span>
          )}
          <Mono className="truncate font-semibold" title={r.target}>{r.target}</Mono>
        </button>
        <div className="flex items-center gap-3 shrink-0">
          {r.totalTokens != null && r.totalTokens > 0 && <span className="text-xs text-muted-foreground tabular-nums hidden sm:inline">{r.totalTokens.toLocaleString()} tokens</span>}
          {r.mapped != null && r.total != null && <span className="text-xs text-muted-foreground tabular-nums">{r.mapped}/{r.total} cols</span>}
          {r.error && r.status === 'FAILED' && <span className="text-xs text-destructive truncate max-w-[220px]" title={r.error}>{r.error}</span>}
          <BulkStatusBadge status={r.status} />
        </div>
      </div>

      {r.expanded && (
        <div className="px-4 pb-4 space-y-3 bg-surface-sunken/60 border-t">
          {/* Retrieval + grounding + token captions (same info as single-target §4). */}
          <div className="pt-3 flex flex-wrap gap-2">
            {(r.examplesUsed ?? 0) > 0 && (
              <MetaChip title={`Guided by ${r.examplesUsed} reference example(s), retrieved via ${r.retrievalMethod === 'vector_search' ? 'semantic Vector Search' : 'lexical matching'}.`}>
                {r.examplesUsed} reference example{r.examplesUsed === 1 ? '' : 's'} · {r.retrievalMethod === 'vector_search' ? 'Vector Search' : 'lexical matching'}
              </MetaChip>
            )}
            {(r.examplesUsed ?? 0) === 0 && r.retrievalMethod && (
              <MetaChip>No prior examples matched · {r.retrievalMethod === 'vector_search' ? 'Vector Search' : 'lexical'} retrieval</MetaChip>
            )}
            {r.selectedEndpoint && (
              <MetaChip title="Model auto-selected by task size">{r.selectedEndpoint} · auto-selected</MetaChip>
            )}
            {r.referenceUsed && (() => {
              const g = groundingChip(r.referenceSources, 'Grounded in reference documents');
              return <MetaChip title={g.title}>{g.text}</MetaChip>;
            })()}
            {r.totalTokens != null && r.totalTokens > 0 && (
              <MetaChip>{r.totalTokens.toLocaleString()} tokens this task{r.promptTokens ? ` · ${r.promptTokens.toLocaleString()} in / ${(r.completionTokens ?? 0).toLocaleString()} out` : ''}</MetaChip>
            )}
          </div>

          {r.sql && (
            <pre className="code-surface p-4 text-xs leading-relaxed overflow-auto whitespace-pre-wrap max-h-64 thin-scroll">{r.sql}</pre>
          )}

          {/* Per-target refine box (mirrors single-target mode). */}
          {r.sql && (
            <RefineBox
              value={r.instructions ?? ''}
              onChange={onInstructions}
              scopeNote={<>applies to <span className="font-mono">{r.target}</span> only</>}
              placeholder="e.g. Cast amount columns to DECIMAL(18,2); trim whitespace on IDs."
              action={
                <Button size="sm" variant="outline" onClick={onRegenerate} disabled={r.regenerating || !(r.instructions ?? '').trim()}>
                  <Sparkles className="h-4 w-4 mr-1.5" /> {r.regenerating ? 'Regenerating…' : 'Regenerate with instructions'}
                </Button>
              }
            />
          )}

          {/* Action row — same grouping/placement as single-target mode. */}
          {r.sql && (
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" onClick={onValidate} disabled={r.validating || r.regenerating}>
                <CheckCircle2 className="h-4 w-4 mr-1.5" /> {r.validating ? 'Validating…' : 'Validate'}
              </Button>
              {done && (
                <>
                  <Button size="sm" variant="outline" onClick={onSave} disabled={r.saving || r.savingExample || r.saved}>
                    <Save className="h-4 w-4 mr-1.5" /> {r.saving ? 'Submitting…' : r.saved ? 'Submitted for review' : 'Submit for review'}
                  </Button>
                  {isEditor && (
                    <Button size="sm" variant="outline" onClick={onSaveExample} disabled={r.saving || r.savingExample || r.savedExample}>
                      <Star className="h-4 w-4 mr-1.5" /> {r.savingExample ? 'Saving…' : r.savedExample ? 'Saved as example' : 'Save as example'}
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
          {r.item?.validationReport && <ValidationSummary report={r.item.validationReport} />}
          {r.status === 'FAILED' && r.error && <p className="text-xs text-destructive">{r.error}</p>}

          {/* Data preview (lazy-loaded on expand). */}
          {done && (
            <PreviewPanel
              compact
              meta={r.preview && r.preview.columns.length > 0
                ? `${r.preview.rows.length} row${r.preview.rows.length === 1 ? '' : 's'} · ${r.preview.columns.length} col${r.preview.columns.length === 1 ? '' : 's'}`
                : null}
            >
              {(r.previewing || r.validating) && <p className="text-xs text-muted-foreground px-4 py-3">{r.validating ? 'Validating…' : 'Running preview…'}</p>}
              {!r.validating && r.previewError && <p className="text-xs text-destructive px-4 py-3">Preview failed: {r.previewError}</p>}
              {!r.validating && r.preview && <PreviewTable preview={r.preview} />}
            </PreviewPanel>
          )}

        </div>
      )}
    </div>
  );
}

function DownloadMenu({ onExcel, onPdf, iconOnly }: { onExcel: () => void; onPdf: () => void; iconOnly?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {iconOnly ? (
          <Button variant="outline" size="icon" className="h-9 w-9" title="Download mapping (Excel / PDF)">
            <Download className="h-4 w-4" />
          </Button>
        ) : (
          <Button variant="outline">
            <Download className="h-4 w-4 mr-1.5" /> Download Mapping <ChevronDown className="h-4 w-4 ml-1.5 opacity-70" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onExcel}>
          <FileSpreadsheet className="h-4 w-4 mr-2 text-success" /> Excel (.xls)
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onPdf}>
          <FileText className="h-4 w-4 mr-2 text-brand" /> PDF
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MappingGrid({
  mappings,
  sources,
  onEdit,
  filter,
  voted,
  onVote,
}: {
  mappings: AttributeMapping[];
  sources: SourceTable[];
  onEdit: (idx: number, sourceTable: string | null, sourceColumn: string | null) => void;
  filter: string;
  voted: Record<string, 'up' | 'down'>;
  onVote: (m: AttributeMapping, vote: 'up' | 'down') => void;
}) {
  const byTable = useMemo(() => new Map(sources.map((s) => [s.table, s])), [sources]);
  const tableOpts = useMemo(() => [...byTable.keys()].sort(), [byTable]);
  const needle = filter.trim().toLowerCase();
  // Keep original indices (edits use them); filter for display only.
  const visible = mappings
    .map((m, i) => ({ m, i }))
    .filter(({ m }) =>
      !needle ||
      [m.target_column, m.source_table, m.source_column].some((v) => String(v ?? '').toLowerCase().includes(needle)),
    );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[30%] pl-6">Target column</TableHead>
          <TableHead className="w-1/4">Source table</TableHead>
          <TableHead className="w-1/4">Source column</TableHead>
          <TableHead>Match</TableHead>
          <TableHead className="text-right pr-6">Feedback</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visible.map(({ m, i }) => {
          const colOpts = m.source_table ? (byTable.get(m.source_table)?.columns.map((c) => c.name) ?? []) : [];
          const mapped = Boolean(m.source_table && m.source_column);
          return (
            <TableRow key={m.target_column}>
              <TableCell className="align-middle pl-6 py-2.5">
                <Mono className="font-semibold text-foreground">{m.target_column}</Mono>
                {/* Long descriptions are cut off with an ellipsis (capped width) so they don't
                    stretch the target column and push the source pickers away; the full
                    text shows as a hover tooltip. */}
                {m.rationale && (
                  <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-xs cursor-help" title={m.rationale}>
                    {m.rationale}
                  </p>
                )}
              </TableCell>
              <TableCell>
                <SearchableSelect
                  value={m.source_table ?? '__none__'}
                  onValueChange={(v) => onEdit(i, v === '__none__' ? null : v, null)}
                  className="w-full font-mono text-[0.8125rem]"
                  placeholder="—"
                  options={[{ value: '__none__', label: '—' }, ...tableOpts.map((t) => ({ value: t, label: t }))]}
                />
              </TableCell>
              <TableCell>
                <SearchableSelect
                  value={m.source_column ?? '__none__'}
                  onValueChange={(v) => onEdit(i, m.source_table, v === '__none__' ? null : v)}
                  disabled={!m.source_table}
                  className="w-full font-mono text-[0.8125rem]"
                  placeholder="—"
                  options={[{ value: '__none__', label: '—' }, ...colOpts.map((c) => ({ value: c, label: c }))]}
                />
              </TableCell>
              <TableCell>
                {mapped ? confidenceBadge(m.confidence) : (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[0.8125rem] font-semibold text-brand-soft-foreground">
                    <span className="h-2 w-2 rounded-full bg-brand" />—
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right pr-6">
                {mapped && (
                  <div className="inline-flex items-center gap-1.5">
                    <button
                      type="button"
                      title="Correct match — reinforce for future discovery"
                      onClick={() => onVote(m, 'up')}
                      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${voted[m.target_column] === 'up' ? 'bg-success border-success text-white' : 'border-input bg-card text-muted-foreground hover:bg-success-soft hover:text-success-soft-foreground'}`}
                    >
                      <ThumbsUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Wrong match — avoid in future discovery"
                      onClick={() => onVote(m, 'down')}
                      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${voted[m.target_column] === 'down' ? 'bg-brand-strong border-brand-strong text-white' : 'border-input bg-card text-muted-foreground hover:bg-danger-soft hover:text-danger-soft-foreground'}`}
                    >
                      <ThumbsDown className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function ValidationSummary({ report }: { report: ValidationReport }) {
  const counts = report.columns.reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2 flex-wrap">
        {Object.entries(counts).map(([k, v]) => (
          <StatusPill key={k} tone={k === 'matched' ? 'success' : k === 'extra' ? 'neutral' : 'danger'}>{k}: {v}</StatusPill>
        ))}
      </div>
      {report.columns
        .filter((c) => c.status !== 'matched')
        .map((c) => (
          <p key={c.target_column} className="text-xs text-muted-foreground">
            <Mono className="text-xs font-semibold text-foreground">{c.target_column}</Mono> — {c.detail ?? c.status}
          </p>
        ))}
    </div>
  );
}

// Visual column lineage: source columns (left) and target columns (right) as nodes,
// with curved connectors between mapped pairs. Mapped nodes/links are teal (tinted by
// confidence); UNMAPPED source columns (not used by any target) and UNMAPPED target
// columns (no confident source) are color-coded amber/red so gaps are obvious.
// Interactive: hover/click a node to spotlight its links (others dim), click to pin
// a focus, and filter to mapped/unmapped. Endpoints are measured from the DOM so
// connectors track the rendered layout.
type LineageSel = { side: 'src' | 'tgt'; key: string } | null;
function ColumnLineageGraph({ sources, mappings, targetTable }: { sources: SourceTable[]; mappings: AttributeMapping[]; targetTable?: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const srcRefs = useRef<Map<string, HTMLElement>>(new Map());
  const tgtRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [links, setLinks] = useState<{ key: string; srcKey: string; x1: number; y1: number; x2: number; y2: number; conf: number }[]>([]);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [hovered, setHovered] = useState<LineageSel>(null);
  const [pinned, setPinned] = useState<LineageSel>(null);
  const [filter, setFilter] = useState<'all' | 'mapped' | 'unmapped'>('all');

  // Which source columns are actually used by a mapping (for unmapped color-coding).
  const usedSourceKeys = useMemo(() => {
    const set = new Set<string>();
    for (const m of mappings) if (m.source_table && m.source_column) set.add(`${m.source_table}.${m.source_column}`);
    return set;
  }, [mappings]);

  // Adjacency: source key ↔ target columns it feeds.
  const srcToTargets = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const m of mappings) {
      if (!m.source_table || !m.source_column) continue;
      const k = `${m.source_table}.${m.source_column}`;
      if (!map.has(k)) map.set(k, new Set());
      map.get(k)!.add(m.target_column);
    }
    return map;
  }, [mappings]);
  const targetToSrc = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of mappings) if (m.source_table && m.source_column) map.set(m.target_column, `${m.source_table}.${m.source_column}`);
    return map;
  }, [mappings]);

  const mappedTargetCount = mappings.filter((m) => m.source_table && m.source_column).length;

  // Row visibility per the filter (used sources / mapped targets, or their inverse).
  const showSrc = (key: string) => (filter === 'all' ? true : filter === 'mapped' ? usedSourceKeys.has(key) : !usedSourceKeys.has(key));
  const showTgt = (m: AttributeMapping) => {
    const mapped = !!(m.source_table && m.source_column);
    return filter === 'all' ? true : filter === 'mapped' ? mapped : !mapped;
  };

  // The active selection = pinned (sticky) or hovered (transient).
  const active = pinned ?? hovered;

  // Set of keys highlighted by the active selection.
  const highlight = useMemo(() => {
    const src = new Set<string>();
    const tgt = new Set<string>();
    if (!active) return { src, tgt, on: false };
    if (active.side === 'src') {
      src.add(active.key);
      for (const t of srcToTargets.get(active.key) ?? []) tgt.add(t);
    } else {
      tgt.add(active.key);
      const s = targetToSrc.get(active.key);
      if (s) src.add(s);
    }
    return { src, tgt, on: true };
  }, [active, srcToTargets, targetToSrc]);

  // Measure node centers (relative to the container) and build connector coordinates.
  useLayoutEffect(() => {
    const measure = () => {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box) return;
      setDims({ w: box.width, h: box.height });
      const center = (el: HTMLElement | undefined, side: 'left' | 'right') => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: (side === 'left' ? r.right : r.left) - box.left, y: r.top + r.height / 2 - box.top };
      };
      const next: typeof links = [];
      for (const m of mappings) {
        if (!m.source_table || !m.source_column) continue;
        const srcKey = `${m.source_table}.${m.source_column}`;
        const s = center(srcRefs.current.get(srcKey), 'right');
        const t = center(tgtRefs.current.get(m.target_column), 'left');
        if (s && t) next.push({ key: m.target_column, srcKey, x1: s.x, y1: s.y, x2: t.x, y2: t.y, conf: m.confidence });
      }
      setLinks(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
    // Re-measure when the filter changes row visibility too.
  }, [sources, mappings, filter]);

  const linkColor = (conf: number) => (conf >= 0.8 ? 'var(--success)' : conf >= CONFIDENCE_THRESHOLD ? 'var(--warning)' : 'var(--chart-5)');

  // Toggle pin on click; hovering a different node while pinned keeps the pin.
  const clickNode = (sel: NonNullable<LineageSel>) =>
    setPinned((p) => (p && p.side === sel.side && p.key === sel.key ? null : sel));

  const FILTERS: { key: typeof filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'mapped', label: 'Mapped' },
    { key: 'unmapped', label: 'Unmapped' },
  ];

  return (
    <div className="border rounded-xl p-4 space-y-3 bg-card" onMouseLeave={() => setHovered(null)}>
      {/* Legend + summary + filter + focus controls. */}
      <div className="flex items-center gap-4 flex-wrap text-xs text-muted-foreground">
        <span className="font-semibold text-foreground tabular-nums">{mappedTargetCount}/{mappings.length} target columns mapped</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-success" /> mapped (≥80%)</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-warning" /> low-confidence</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-brand" /> unmapped target</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-muted-foreground/50" /> unused source</span>
        <div className="ml-auto flex items-center gap-2">
          {pinned && (
            <button type="button" onClick={() => setPinned(null)} className="text-xs font-semibold text-brand hover:underline">Clear focus</button>
          )}
          <div className="inline-flex rounded-lg bg-surface-sunken p-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${filter === f.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">Hover a column to spotlight its links; click to pin the focus.</p>

      {/* ER-style: compact entity cards (title header + tightly-packed, divided column
          rows) on each side, joined by curved relationship connectors. A colored left
          rail on each row encodes mapped/low-confidence/unmapped without bulky pills. */}
      <div ref={containerRef} className="relative grid grid-cols-2 gap-x-28 items-start">
        {/* SVG connector overlay spanning the whole graph. */}
        <svg className="absolute inset-0 pointer-events-none" width={dims.w} height={dims.h} style={{ overflow: 'visible' }}>
          {links.map((l) => {
            const mx = (l.x1 + l.x2) / 2;
            const isActive = highlight.on && (highlight.tgt.has(l.key) && highlight.src.has(l.srcKey));
            const dim = highlight.on && !isActive;
            return (
              <g key={l.key}>
                <path
                  d={`M ${l.x1} ${l.y1} C ${mx} ${l.y1}, ${mx} ${l.y2}, ${l.x2} ${l.y2}`}
                  fill="none"
                  stroke={linkColor(l.conf)}
                  strokeWidth={isActive ? 2.75 : 1.5}
                  strokeOpacity={dim ? 0.1 : isActive ? 0.95 : 0.55}
                  style={{ transition: 'stroke-width 150ms ease, stroke-opacity 150ms ease' }}
                />
                {/* Small endpoint dots (ER "connection points"). */}
                <circle cx={l.x1} cy={l.y1} r={isActive ? 3 : 2} fill={linkColor(l.conf)} opacity={dim ? 0.1 : 0.9} />
                <circle cx={l.x2} cy={l.y2} r={isActive ? 3 : 2} fill={linkColor(l.conf)} opacity={dim ? 0.1 : 0.9} />
              </g>
            );
          })}
        </svg>

        {/* Left: source entities. */}
        <div className="space-y-4 min-w-0">
          {sources.map((s) => {
            const visible = s.columns.filter((c) => showSrc(`${s.table}.${c.name}`));
            if (visible.length === 0) return null;
            return (
              <div key={s.table} className="rounded-lg border border-border bg-card overflow-hidden">
                <div className="px-2.5 py-1.5 bg-surface-sunken border-b border-border flex items-center gap-1.5">
                  <TableProperties className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="font-mono text-xs font-semibold text-foreground truncate" title={s.table}>{s.table}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">{s.columns.length}</span>
                </div>
                <div className="divide-y divide-border">
                  {visible.map((c) => {
                    const key = `${s.table}.${c.name}`;
                    const used = usedSourceKeys.has(key);
                    const isHi = highlight.src.has(key);
                    const dim = highlight.on && !isHi;
                    const isPinned = pinned?.side === 'src' && pinned.key === key;
                    return (
                      <div
                        key={key}
                        ref={(el) => { if (el) srcRefs.current.set(key, el); else srcRefs.current.delete(key); }}
                        onMouseEnter={() => setHovered({ side: 'src', key })}
                        onClick={() => clickNode({ side: 'src', key })}
                        className={`group flex items-center gap-2 pl-2 pr-2.5 py-1 text-xs cursor-pointer border-l-2 transition-colors ${used ? 'border-l-success' : 'border-l-muted-foreground/30'} ${isHi ? 'bg-brand-soft' : 'hover:bg-muted/60'} ${isPinned ? 'bg-brand-soft' : ''} ${dim ? 'opacity-40' : ''}`}
                        title={used ? `${c.name} — mapped` : `${c.name} — not used by any target`}
                      >
                        <span className={`truncate font-mono ${used ? 'text-foreground' : 'text-muted-foreground'}`}>{c.name}</span>
                        {c.typeName && <span className="ml-auto text-[10px] text-muted-foreground shrink-0 tabular-nums lowercase">{c.typeName}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {sources.every((s) => s.columns.every((c) => !showSrc(`${s.table}.${c.name}`))) && (
            <p className="text-xs text-muted-foreground">No source columns match this filter.</p>
          )}
        </div>

        {/* Right: target entity. */}
        <div className="min-w-0">
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="px-2.5 py-1.5 bg-ink text-ink-foreground border-b border-border flex items-center gap-1.5">
              <TableProperties className="h-3.5 w-3.5 text-brand shrink-0" />
              <span className="font-mono text-xs font-semibold truncate" title={targetTable}>{targetTable || 'Target'}</span>
              <span className="ml-auto text-[10px] text-ink-muted tabular-nums">{mappedTargetCount}/{mappings.length}</span>
            </div>
            <div className="divide-y divide-border">
              {mappings.filter(showTgt).map((m) => {
                const mapped = !!(m.source_table && m.source_column);
                const rail = mapped ? (m.confidence >= 0.8 ? 'border-l-success' : 'border-l-warning') : 'border-l-brand';
                const isHi = highlight.tgt.has(m.target_column);
                const dim = highlight.on && !isHi;
                const isPinned = pinned?.side === 'tgt' && pinned.key === m.target_column;
                return (
                  <div
                    key={m.target_column}
                    ref={(el) => { if (el) tgtRefs.current.set(m.target_column, el); else tgtRefs.current.delete(m.target_column); }}
                    onMouseEnter={() => setHovered({ side: 'tgt', key: m.target_column })}
                    onClick={() => clickNode({ side: 'tgt', key: m.target_column })}
                    className={`flex items-center gap-2 pl-2 pr-2.5 py-1 text-xs cursor-pointer border-l-2 transition-colors ${rail} ${isHi ? 'bg-brand-soft' : 'hover:bg-muted/60'} ${isPinned ? 'bg-brand-soft' : ''} ${dim ? 'opacity-40' : ''}`}
                    title={mapped ? `${m.target_column} ← ${m.source_table}.${m.source_column} (${Math.round(m.confidence * 100)}%)` : `${m.target_column} — no confident source (emits NULL)`}
                  >
                    <span className="truncate font-mono text-foreground">{m.target_column}</span>
                    {mapped
                      ? <span className="ml-auto shrink-0 tabular-nums text-[10px] text-muted-foreground">{Math.round(m.confidence * 100)}%</span>
                      : <span className="ml-auto shrink-0 text-[10px] font-semibold text-brand-soft-foreground">NULL</span>}
                  </div>
                );
              })}
              {mappings.filter(showTgt).length === 0 && <p className="px-2.5 py-2 text-xs text-muted-foreground">No target columns match this filter.</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewTable({ preview }: { preview: PreviewData }) {
  if (preview.columns.length === 0) return <p className="text-xs text-muted-foreground">No columns returned.</p>;
  if (preview.rows.length === 0) return <p className="text-xs text-muted-foreground">Query returned no rows.</p>;
  return (
    // White surface + capped height with a sticky header, so a wide/tall preview
    // scrolls within its panel rather than pushing the page around.
    // NOTE: a plain <table> is used (not <Table>) because <Table> wraps itself in its
    // own overflow container, which becomes the sticky ancestor and stops the header
    // from floating. Here ONE container owns both scroll axes, so the header stays
    // pinned while scrolling down to the horizontal scrollbar.
    <div className="overflow-auto bg-card max-h-80 relative thin-scroll">
      <table className="w-full caption-bottom text-sm border-separate border-spacing-0">
        <TableHeader>
          <TableRow>
            {preview.columns.map((c) => (
              <TableHead
                key={c}
                className="sticky top-0 z-10 bg-card font-mono font-semibold text-muted-foreground whitespace-nowrap border-b"
              >
                {c}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {preview.rows.map((r, ri) => (
            // eslint-disable-next-line react/no-array-index-key -- preview rows have no stable id
            <TableRow key={ri}>
              {r.map((v, ci) => (
                // eslint-disable-next-line react/no-array-index-key -- positional cells
                <TableCell key={ci} className="font-mono text-xs whitespace-nowrap tabular-nums py-2.5">{v ?? <span className="text-muted-foreground italic">NULL</span>}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </table>
    </div>
  );
}
