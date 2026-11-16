/**
 * Source-table selection for attribute discovery (match-attributes).
 *
 * Problem: discovery renders EVERY column of EVERY selected source table into one
 * prompt. A wide schema (e.g. 320 tables / 10k columns ≈ 850k chars ≈ 210k tokens)
 * overflows the model context window. This module keeps the discovery prompt bounded:
 *
 *   1. rankSourceTables  – score each table by name-token overlap with the target
 *                          (column names + entity name, with Epic/Clarity abbreviation
 *                          normalisation) and keep the top N. Tables carrying a
 *                          confirmed (thumbs-up) feedback pick are always kept.
 *   2. batchSourceTables – pack the kept tables into batches whose rendered size stays
 *                          under a per-call char budget.
 *   3. mergeBatchMappings – combine per-batch results, keeping the highest-confidence
 *                          valid pick for each target column.
 *
 * Pure functions (no I/O) so they are unit-testable.
 */
import type { TargetEntity, SourceTable } from './types.js';

/** Max core tables sent to discovery after pre-filtering (small lookup tables may be added on top). */
export const MAX_DISCOVERY_TABLES = 40;
/** Rendered source-table char budget per discovery LLM call (~30k tokens). */
export const DISCOVERY_BATCH_CHARS = 120_000;
/** Hard cap on discovery LLM calls per request. */
export const MAX_DISCOVERY_BATCHES = 4;
/** Concurrent discovery LLM calls. */
export const DISCOVERY_CONCURRENCY = 2;
/** Above this many selected tables the UI warns that pre-filtering will apply. */
export const LARGE_SELECTION_WARN = MAX_DISCOVERY_TABLES;

// Abbreviation → canonical token, so Epic/Clarity names (PAT_ENC_HSP, ADMSN, DISCH)
// overlap with target names (patient, encounter, hospital, admission, discharge).
const ABBREV: Record<string, string> = {
  pat: 'patient', pt: 'patient', enc: 'encounter', csn: 'encounter', hsp: 'hospital', hosp: 'hospital',
  adm: 'admission', admsn: 'admission', admit: 'admission', disch: 'discharge', dischrg: 'discharge', dsch: 'discharge',
  dept: 'department', dep: 'department', prov: 'provider', practitioner: 'provider', ser: 'provider',
  dx: 'diagnosis', diag: 'diagnosis', px: 'procedure', proc: 'procedure', mrn: 'mrn', dob: 'birth', bth: 'birth',
  dt: 'date', tm: 'time', dttm: 'datetime', num: 'number', nbr: 'number', no: 'number',
  desc: 'description', dscr: 'description', addr: 'address', zip: 'zip', st: 'state',
  acct: 'account', med: 'medication', rx: 'medication', ord: 'order', lab: 'lab', res: 'result', rslt: 'result',
  loc: 'location', svc: 'service', serv: 'service', rsn: 'reason', cls: 'class', wt: 'weight', ht: 'height',
  ins: 'insurance', cvg: 'coverage', pay: 'payer', payor: 'payer', fin: 'financial', chg: 'charge', chgs: 'charge',
  zc: '', incr: '', cv: '', clarity: '', c: '', yn: '', id: 'id',
};
// Tokens that appear almost everywhere — weak evidence of relevance.
const GENERIC = new Set(['id', 'code', 'description', 'name', 'title', 'date', 'time', 'datetime', 'type', 'status', 'number', 'flag', 'indicator', 'value']); // reconstructed: list tail after 'value' was cut off
const GENERIC_WEIGHT = 0.15;

export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => (Object.prototype.hasOwnProperty.call(ABBREV, t) ? ABBREV[t] : t))
    .filter((t) => t.length > 1 && !/^\d+$/.test(t));
}

export interface RankedTable { table: string; score: number }

export interface SourceSelection {
  /** Tables kept, in rank order. */
  kept: SourceTable[];
  /** Tables dropped by the pre-filter (lowest-scoring first-dropped order not guaranteed). */
  skipped: string[];
  /** Per-table scores for transparency/debugging. */
  ranking: RankedTable[];
}

/**
 * Score a source table by overlap between its tokens (table name + column names)
 * and the target's tokens (entity name + target column names). Specific tokens
 * count fully, generic ones (id/code/date…) weakly; a table-name hit on an entity
 * token gets a bonus. Returns a non-negative number; higher = more relevant.
 */
export function scoreSourceTable(target: TargetEntity, src: SourceTable): number {
  const targetTok = new Map<string, number>(); // token -> weight
  const add = (t: string, w: number) => targetTok.set(t, Math.max(targetTok.get(t) ?? 0, w));
  for (const t of nameTokens(target.target_table)) add(t, GENERIC.has(t) ? GENERIC_WEIGHT : 1.5);
  for (const c of target.columns) for (const t of nameTokens(c.target_column)) add(t, GENERIC.has(t) ? GENERIC_WEIGHT : 1);

  const srcCols = new Set<string>();
  for (const c of src.columns) for (const t of nameTokens(c.name)) srcCols.add(t);
  const tableTok = new Set(nameTokens(src.table));

  let score = 0;
  for (const [t, w] of targetTok) {
    if (srcCols.has(t)) score += w;
    if (tableTok.has(t)) score += w; // table named after a target concept is a strong signal
  }
  // Normalise lightly by width so very wide tables don't win on sheer column count.
  return score / Math.sqrt(Math.max(1, Math.log2(src.columns.length + 1)));
}

/**
 * Keep at most `maxTables` tables, ranked by {@link scoreSourceTable}. Tables in
 * `mustKeep` (e.g. sources of confirmed feedback picks) are always kept first.
 * When the selection already fits, every table is kept (order preserved).
 */
export function rankSourceTables(
  target: TargetEntity,
  sources: SourceTable[],
  maxTables: number = MAX_DISCOVERY_TABLES,
  mustKeep: Iterable<string> = [],
): SourceSelection {
  const ranking = sources
    .map((s) => ({ table: s.table, score: scoreSourceTable(target, s) }))
    .sort((a, b) => b.score - a.score || a.table.localeCompare(b.table));
  if (sources.length <= maxTables) {
    return { kept: sources.slice(), skipped: [], ranking };
  }
  const byName = new Map(sources.map((s) => [s.table, s]));
  const must = new Set([...mustKeep].filter((t) => byName.has(t)));

  // 1) Collapse near-duplicate copies (e.g. `pat_enc` vs its curated `incr_cv_pat_enc`:
  //    one name is a `_`-suffix of the other and ≥90% of columns overlap) so duplicates
  //    don't eat the budget. Keep the feedback-confirmed one, else the longer name.
  const colSet = new Map(sources.map((s) => [s.table, new Set(s.columns.map((c) => c.name.toLowerCase()))]));
  const dupOf = new Map<string, string>(); // dropped table -> representative
  for (const a of sources) {
    for (const b of sources) {
      if (a === b || !a.table.endsWith(`_${b.table}`)) continue; // a = longer (prefixed) name
      const ca = colSet.get(a.table)!, cb = colSet.get(b.table)!;
      let inter = 0;
      for (const c of cb) if (ca.has(c)) inter++;
      const jaccard = inter / (ca.size + cb.size - inter || 1);
      if (jaccard < 0.9) continue;
      const [keepT, dropT] = must.has(b.table) && !must.has(a.table) ? [b.table, a.table] : [a.table, b.table];
      if (!must.has(dropT)) dupOf.set(dropT, keepT);
    }
  }
  const candidates = ranking.filter((r) => !dupOf.has(r.table));

  const keep = new Set<string>();
  const addCore = (t: string) => { if (keep.size < maxTables) keep.add(t); };
  for (const t of must) addCore(t);

  // 2) Core tables: the highest-scoring tables, up to maxTables.
  for (const r of candidates) addCore(r.table);

  // 3) Lookup expansion: small code/lookup tables (e.g. Epic ZC_*: CODE_C, NAME, TITLE)
  //    score low on name overlap but are needed for *_description columns. They're tiny,
  //    so add up to MAX_LOOKUP_TABLES extra small tables that share a specific key column
  //    (…_C / …_ID, not PAT_ID) with one of the TOP core tables, preferring joins to
  //    higher-ranked core tables.
  const coreOrder = [...keep];
  const keyRank = new Map<string, number>(); // key column -> best rank of a core table holding it
  coreOrder.slice(0, LOOKUP_ANCHOR_TABLES).forEach((t, i) => {
    for (const c of byName.get(t)!.columns) {
      const n = c.name.toLowerCase();
      if (/_(c|id)$/.test(n) && n !== 'pat_id' && n.length > 4 && !keyRank.has(n)) keyRank.set(n, i);
    }
  });
  const lookups = candidates
    .filter((r) => !keep.has(r.table) && byName.get(r.table)!.columns.length <= LOOKUP_MAX_COLUMNS)
    .map((r) => {
      let best = Infinity;
      for (const c of byName.get(r.table)!.columns) {
        const k = keyRank.get(c.name.toLowerCase());
        if (k !== undefined && k < best) best = k;
      }
      return { ...r, anchor: best };
    })
    .filter((r) => r.anchor !== Infinity)
    .sort((a, b) => a.anchor - b.anchor || b.score - a.score || a.table.localeCompare(b.table));
  for (const r of lookups.slice(0, MAX_LOOKUP_TABLES)) keep.add(r.table);

  const kept = ranking.filter((r) => keep.has(r.table)).map((r) => byName.get(r.table)!);
  const skipped = sources.filter((s) => !keep.has(s.table)).map((s) => s.table);
  return { kept, skipped, ranking };
}

/** Tables with at most this many columns are treated as lookup/code tables for expansion. */
const LOOKUP_MAX_COLUMNS = 20;
/** Extra small lookup tables allowed on top of maxTables (they cost ~150 chars each). */
const MAX_LOOKUP_TABLES = 25;
/** Only key columns of the top N core tables seed lookup expansion. */
const LOOKUP_ANCHOR_TABLES = 8;

/** Approximate chars a table contributes to the discovery prompt (mirrors renderSourceTables). */
export function renderedTableChars(src: SourceTable): number {
  let n = `### Source table: ${src.table}\n`.length + 2 + (src.table.length + 2) * 2; // header + spacing + name in the two allow-lists
  for (const c of src.columns) {
    n += 5 + c.name.length + String(c.typeText ?? c.typeName ?? '').length + (c.nullable ? 0 : 9) + (c.comment ? c.comment.length + 4 : 0);
  }
  return n;
}

/**
 * Pack tables (in the given order) into batches whose rendered size stays under
 * `charBudget`. A single table larger than the budget gets its own batch (the
 * caller's hard guard decides whether that still fits the model).
 */
export function batchSourceTables(sources: SourceTable[], charBudget: number = DISCOVERY_BATCH_CHARS): SourceTable[][] {
  const batches: SourceTable[][] = [];
  let cur: SourceTable[] = [];
  let curChars = 0;
  for (const s of sources) {
    const c = renderedTableChars(s);
    if (cur.length > 0 && curChars + c > charBudget) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(s);
    curChars += c;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

export interface CandidateMapping {
  target_column: string;
  source_table: string | null;
  source_column: string | null;
  confidence: number;
  rationale: string;
}

/**
 * Merge per-batch mappings: for each target column (in target order) keep the
 * highest-confidence mapped pick; if no batch mapped it, keep the first unmatched
 * rationale. Inputs are assumed already validated (unmapped → null source).
 */
export function mergeBatchMappings(targetCols: string[], batches: CandidateMapping[][]): CandidateMapping[] {
  return targetCols.map((tc) => {
    let best: CandidateMapping | null = null;
    let fallback: CandidateMapping | null = null;
    for (const b of batches) {
      const m = b.find((x) => x.target_column === tc);
      if (!m) continue;
      if (m.source_table && m.source_column) {
        if (!best || m.confidence > best.confidence) best = m;
      } else if (!fallback) {
        fallback = m;
      }
    }
    return best ?? fallback ?? { target_column: tc, source_table: null, source_column: null, confidence: 0, rationale: '' };
  });
}

/** Run async tasks with a concurrency cap, preserving input order in the result. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
