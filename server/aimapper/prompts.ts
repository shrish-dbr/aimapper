// Prompt assembly for target-driven attribute discovery and JOIN SQL generation.
// Pure functions so they're easy to unit-test independently of the LLM call.
import type { AttributeMapping, MappingExample, TargetColumn, TargetEntity, SourceTable } from './types.js';

export const CONFIDENCE_THRESHOLD = 0.6;

/** Aggregated user feedback on prior mapping picks, used to steer discovery. */
export interface MappingFeedback {
  target_column: string;
  source_table: string | null;
  source_column: string | null;
  up: number;
  down: number;
}

/** Render a compact steering block from user 👍/👎 feedback, or '' if none. */
function renderFeedback(feedback?: MappingFeedback[]): string {
  if (!feedback || feedback.length === 0) return '';
  const confirmed = feedback.filter((f) => f.up > f.down && f.source_table && f.source_column);
  const rejected = feedback.filter((f) => f.down > f.up && f.source_table && f.source_column);
  if (confirmed.length === 0 && rejected.length === 0) return '';
  const lines: string[] = [];
  if (confirmed.length) {
    lines.push('PREFER these source columns (confirmed correct by users):');
    for (const f of confirmed) lines.push(`  - ${f.target_column} <- ${f.source_table}.${f.source_column}`);
  }
  if (rejected.length) {
    lines.push('AVOID these source columns (rejected by users as wrong) — pick a different source or leave unmatched:');
    for (const f of rejected) lines.push(`  - ${f.target_column} !=  ${f.source_table}.${f.source_column}`);
  }
  return `\n\nUser feedback from prior mappings to this target — honor it strongly:\n${lines.join('\n')}`;
}

/** Prefix that marks a mapping description as an approximation of composite logic. */
export const COMPOSITE_APPROX_PREFIX = 'Approximation (composite logic):';

/**
 * Make a mapping's description explicitly state that it is an approximation when
 * the target needs several source columns combined and/or a non-trivial
 * transformation. A mapping holds ONE source column, so composite logic can only be
 * approximated by its primary column. Pure and idempotent: a description that
 * already carries the prefix is returned unchanged.
 */
export function annotateCompositeRationale(
  rationale: string | null | undefined,
  composite: unknown,
  compositeSources?: unknown,
): string {
  const base = (rationale ?? '').trim();
  if (composite !== true) return base;
  if (base.toLowerCase().startsWith(COMPOSITE_APPROX_PREFIX.toLowerCase())) return base;
  const others = Array.isArray(compositeSources)
    ? compositeSources.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
    : [];
  const parts = [COMPOSITE_APPROX_PREFIX];
  const desc = base || 'target requires combining or transforming multiple source values; only the primary source column is mapped.';
  parts.push(/[.!?]$/.test(desc) ? desc : `${desc}.`);
  if (others.length) parts.push(`Also requires: ${others.join(', ')}.`);
  return parts.join(' ');
}

/** Render a source table's columns compactly. */
function renderSourceColumns(src: SourceTable): string {
  return src.columns
    .map(
      (c) =>
        `  - ${c.name} ${c.typeText ?? c.typeName}${c.nullable ? '' : ' NOT NULL'}${c.comment ? ` // ${c.comment}` : ''}`,
    )
    .join('\n');
}

/** Render several source tables (each with its columns) as one block. */
function renderSourceTables(sources: SourceTable[]): string {
  return sources.map((s) => `### Source table: ${s.table}\n${renderSourceColumns(s)}`).join('\n\n');
}

/** Render a target's column contract compactly. */
function renderTargetColumns(cols: TargetColumn[]): string {
  return cols
    .slice()
    .sort((a, b) => a.ordinal_position - b.ordinal_position)
    .map((c) => {
      // Only DECIMAL(p,s) is a castable length suffix in Spark SQL. STRING/CHAR
      // lengths are a business constraint, NOT a cast type — rendering them as
      // `STRING(20)` makes the LLM emit `CAST(x AS STRING(20))`, which Spark
      // rejects. So append char length as a separate annotation instead.
      let suffix = '';
      let annotation = '';
      if (c.data_type === 'DECIMAL' && c.numeric_precision != null) {
        suffix = `(${c.numeric_precision},${c.numeric_scale ?? 0})`;
      } else if (c.data_length != null) {
        annotation = ` (max length ${c.data_length})`;
      }
      const flags = `${c.is_nullable ? 'NULL' : 'NOT NULL'}${c.is_primary_key ? ', PK' : ''}`;
      const hint = c.transform_hint ? ` -- ${c.transform_hint}` : '';
      return `  - ${c.target_column} ${c.data_type}${suffix} [${flags}]${annotation}${hint}`;
    })
    .join('\n');
}

const HEALTHCARE_RULES = `
Healthcare mapping rules:
- Standardize gender to a single char: MALE->M, FEMALE->F, unknown/null->U.
- Normalize dates DEFENSIVELY. Source date strings are dirty and inconsistent (e.g. '01/01/2020', '20200101', '01-JAN-2020', NULL, ''), and the target runs in ANSI mode where a bad date string ERRORS the whole query. So ALWAYS use the error-tolerant variants that return NULL on bad input — NEVER plain CAST(x AS DATE) or TO_DATE on a raw string. Prefer COALESCE over several try_to_date attempts covering the likely formats, e.g. COALESCE(try_to_date(x,'MM/dd/yyyy'), try_to_date(x,'yyyyMMdd'), try_to_date(x,'dd-MMM-yyyy'), try_cast(x AS DATE)). Use try_cast(... AS TIMESTAMP) similarly for timestamps. Never let a malformed date abort the query.
- Use error-tolerant casts for other risky conversions too: prefer try_cast(...) over CAST(...) for numeric/decimal conversions on free-text source columns so bad values become NULL instead of failing the query.
- Strip non-digits from identifiers like SSN, NPI, NDC (use regexp_replace).
- Strip currency symbols/commas from amounts before CAST to DECIMAL.
- For NOT NULL targets, COALESCE to a safe default or ensure the source is non-null; never emit a NULL into a NOT NULL column.
- Uppercase state codes and 2-char codes; INITCAP names only if the source is all-caps.
- Split combined "Last, First" name fields when the target has separate columns.
- Explicitly cast every output column to the target type so the result schema matches the target contract (CAST or try_cast — see the defensive rules above). Use ONLY valid Spark SQL cast types: STRING (never STRING(n) — Spark has no length on STRING; a "max length" annotation is a business rule, not a cast type — use LEFT(x, n) to enforce it if needed), DATE, TIMESTAMP, INT, BIGINT, DOUBLE, BOOLEAN, and DECIMAL(p,s). Only DECIMAL takes a length. try_to_date / try_to_timestamp / try_cast are all allowed and preferred for dirty source data.
- Map line-of-business / status / type synonyms to the canonical tokens described in the hints.`;

/** [DATA-SAMPLING] Render observed source-data samples, or '' if none.
 * Remove this function (and its call in buildJoinSqlPrompt) to drop the feature. */
function renderSampleContext(sampleContext?: string): string {
  const ctx = (sampleContext ?? '').trim();
  if (!ctx) return '';
  return (
    '\n\nSource data samples — a few ACTUAL values observed in each source column ' +
    '(with null/empty rates). Use them to infer real formats and encodings (date ' +
    'patterns, codes, casing, identifier/currency formatting) and choose the right ' +
    'error-tolerant casts and transformations. This is a small sample and may not ' +
    'cover every value, so keep the defensive rules above:\n' +
    ctx
  );
}

/** Render a reference-documentation grounding block (from the Knowledge
 * Assistant over uploaded source-metadata PDFs), or '' if none. */
function renderReferenceContext(referenceContext?: string): string {
  const ctx = (referenceContext ?? '').trim();
  if (!ctx) return '';
  return (
    '\n\nReference documentation — the following facts were retrieved from ' +
    'source-metadata reference documents (data dictionaries, field definitions, ' +
    'transformation rules). Treat them as authoritative context for this source ' +
    'system and honor them where relevant. Explicit column-level mappings stated here ' +
    'are authoritative, and one source column may legitimately feed several target ' +
    'columns — do not treat such a repeat as a contradiction:\n' +
    ctx
  );
}

// Admin/editor-authored, per-source-system guidance. Rendered as high-priority
// instructions the model should follow for this source system (naming conventions,
// preferred source tables, date formats, mapping rules). Empty string when none is set.
function renderInstructions(instructions?: string): string {
  const text = (instructions ?? '').trim();
  if (!text) return '';
  return (
    '\n\nSource system mapping instructions — the data team has provided the following ' +
    'guidance for this source system. Follow it wherever it applies, unless it would ' +
    'violate a hard requirement above:\n' +
    text
  );
}

// Per-example cap on injected SQL. Set high so a full complex example (CTEs, per-column
// CASE, UNIONs, nested subqueries) actually reaches the model instead of a truncated head.
// The retrieval packer's FEWSHOT_CHAR_BUDGET + the generate handler's prompt-size guard
// bound the overall prompt; the packer always keeps the top-ranked example, so the best
// match is injected in full even if it alone fills the budget (fewer, fuller examples).
export const MAX_EXAMPLE_SQL_CHARS = 200000;

// ---- Prompt Sizing profiles -------------------------------------------------
// A single admin-selectable profile sets a GROUP of prompt/generation caps at
// once (output token budgets + prompt/example/reference/sample sizes), rather
// than exposing a dozen raw dials. `balanced` is the default and matches the
// app's historical constants; `generous` raises everything for big references /
// wide targets / long output; `conservative` shrinks them for cost/latency.
export interface PromptLimits {
  genMaxTokens: number; identifyMaxTokens: number;
  maxPromptChars: number; maxExampleSqlChars: number;
  fewshotCharBudget: number; maxFewshotItems: number;
  maxReferenceContextChars: number; maxPerRunInstructionChars: number;
  maxReferenceQueryColumns: number;
  sampleCharBudget: number; maxSampleValues: number; maxValueChars: number;
}
export type PromptProfile = 'conservative' | 'balanced' | 'generous';
export const DEFAULT_PROMPT_PROFILE: PromptProfile = 'balanced';
export const PROMPT_PROFILES: Record<PromptProfile, PromptLimits> = {
  conservative: { genMaxTokens: 8000,  identifyMaxTokens: 4000,  maxPromptChars: 300000, maxExampleSqlChars: 50000,  fewshotCharBudget: 100000, maxFewshotItems: 10, maxReferenceContextChars: 2000, maxPerRunInstructionChars: 2000, maxReferenceQueryColumns: 20, sampleCharBudget: 20000, maxSampleValues: 50,  maxValueChars: 60  },
  balanced:     { genMaxTokens: 16000, identifyMaxTokens: 8000,  maxPromptChars: 600000, maxExampleSqlChars: 200000, fewshotCharBudget: 200000, maxFewshotItems: 20, maxReferenceContextChars: 4000, maxPerRunInstructionChars: 4000, maxReferenceQueryColumns: 40, sampleCharBudget: 40000, maxSampleValues: 100, maxValueChars: 60  },
  generous:     { genMaxTokens: 32000, identifyMaxTokens: 16000, maxPromptChars: 900000, maxExampleSqlChars: 400000, fewshotCharBudget: 400000, maxFewshotItems: 30, maxReferenceContextChars: 8000, maxPerRunInstructionChars: 8000, maxReferenceQueryColumns: 80, sampleCharBudget: 80000, maxSampleValues: 200, maxValueChars: 120 },
};
/** Resolve a profile name to its limits; unknown/empty → the default profile. */
export function resolvePromptProfile(name?: string | null): PromptLimits {
  const key = (name ?? '').toLowerCase() as PromptProfile;
  return PROMPT_PROFILES[key] ?? PROMPT_PROFILES[DEFAULT_PROMPT_PROFILE];
}

/** Render retrieved few-shot examples as a reference block, or '' if none. */
function renderExamples(examples?: MappingExample[], maxExampleSqlChars: number = MAX_EXAMPLE_SQL_CHARS): string {
  if (!examples || examples.length === 0) return '';
  const blocks: string[] = [];
  examples.forEach((ex, i) => {
    const sql = (ex.generated_sql ?? '').trim().slice(0, maxExampleSqlChars);
    if (!sql) return;
    const note = ex.notes ? `\n-- note: ${ex.notes}` : '';
    const sig = ex.source_signature || 'previous source';
    blocks.push(`Example ${i + 1} (from ${sig}):${note}\n${sql}`);
  });
  if (blocks.length === 0) return '';
  return (
    '\n\nReference conversions — these are known-good mappings to this SAME target table. ' +
    'Follow their transformation patterns, casting style, and conventions where applicable ' +
    `(adapt column names to the current source):\n\n${blocks.join('\n\n')}`
  );
}

/**
 * Attribute discovery: given ONE target entity and SEVERAL source tables,
 * ask the LLM to pick, for each target column, the single best-matching source
 * column across ANY of the source tables.
 */
export function buildAttributeMatchPrompt(
  target: TargetEntity,
  sources: SourceTable[],
  threshold: number = CONFIDENCE_THRESHOLD,
  feedback?: MappingFeedback[],
  referenceContext?: string,
  instructions?: string,
): { role: 'system' | 'user'; content: string }[] {
  const tableNames = sources.map((s) => s.table);
  const targetCols = target.columns.map((c) => c.target_column);

  const system = `You are a data-mapping assistant for a healthcare data platform. You are given ONE target entity and SEVERAL source tables. For EACH target column, identify the single best-matching source column. The matching source column may come from ANY of the source tables — different target columns can map to different source tables. Mappings are NOT one-to-one: the SAME source column MAY be mapped to MORE THAN ONE target column whenever it is the best fit for each (e.g. one amount field feeding both a balance and a budget target). Never leave a target column unmatched, or pick a weaker source, merely because its best source column is already used by another target column. When the reference documentation states an explicit column-level mapping for a target column, treat it as authoritative and use it, even if that source column is also mapped elsewhere. If no source column is a good fit for a target column (confidence below ${threshold}), set source_table and source_column to null and unmatched=true for that column. source_table MUST be one of the provided source tables; source_column MUST be a real column of that table. When user feedback is provided, treat confirmed picks as strong priors and never re-propose a rejected pick. COMPOSITE MAPPINGS: when a target column cannot be populated by a single source column as-is — it needs several source columns combined (concatenation, arithmetic, COALESCE across columns, lookups/joins to derive the value) or a non-trivial transformation (code translation, derivation, date assembly/conversion, conditional CASE logic) — set composite=true, put the PRIMARY contributing column in source_table/source_column, list every OTHER contributing column as "table.column" in composite_sources, and write a rationale that begins with "${COMPOSITE_APPROX_PREFIX}" followed by a short description of the combination/transformation logic. For straightforward single-column mappings (including simple casts, trims, or reformatting of that one column), set composite=false and composite_sources=[]. Respond with ONLY a JSON object, no prose, no markdown fences.`;

  const user = `Target entity: ${target.target_table}
Target columns (in order):
${renderTargetColumns(target.columns)}

Source tables to search (choose source_table from [${tableNames.join(', ')}]):
${renderSourceTables(sources)}${renderInstructions(instructions)}${renderReferenceContext(referenceContext)}${renderFeedback(feedback)}

Return JSON exactly in this shape:
{"target_table":"${target.target_table}","mappings":[{"target_column":"<one of [${targetCols.join(', ')}]>","source_table":"<one of [${tableNames.join(', ')}] or null>","source_column":"<a column of that source table or null>","confidence":<number 0..1>,"rationale":"<one short phrase; must begin with '${COMPOSITE_APPROX_PREFIX}' when composite>","composite":<true|false>,"composite_sources":["<table.column of each OTHER contributing source column>"],"unmatched":<true|false>}]}
Include exactly one mapping object per target column, in target ordinal order.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Join-SQL generation: one Databricks SELECT that reads from the (possibly
 * multiple) source tables and maps their attributes to the target.
 * Injects few-shot `examples` when provided.
 */
// When regenerating with user tweaks, feed the previously-generated SQL back so the
// model refines THAT statement rather than starting from scratch — a "here's what I
// have, apply these changes" framing. Empty when there's no prior SQL.
function renderPriorSql(priorSql?: string): string {
  const sql = (priorSql ?? '').trim();
  if (!sql) return '';
  return (
    '\n\nYou previously generated the SQL below. Treat it as the starting point and ' +
    'apply the requested changes to it, keeping everything else intact. Return the ' +
    'full updated statement (still one read-only query — a SELECT, optionally led by WITH CTEs; no DDL/DML):\n' + sql
  );
}

export function buildJoinSqlPrompt(
  target: TargetEntity,
  sources: SourceTable[],
  mappings: AttributeMapping[],
  examples?: MappingExample[],
  referenceContext?: string,
  instructions?: string,
  priorSql?: string,
  sampleContext?: string, // [DATA-SAMPLING] observed source-data values; '' when disabled
  limits?: Pick<PromptLimits, 'maxExampleSqlChars'>, // Prompt Sizing profile caps (optional; defaults to the balanced per-example cap)
): { role: 'system' | 'user'; content: string }[] {
  const byTable = new Map(sources.map((s) => [s.table, s]));
  // Ordered, de-duped list of source tables actually referenced by the mappings.
  const used: string[] = [];
  const seen = new Set<string>();
  for (const m of mappings) {
    const t = m.source_table;
    if (t && byTable.has(t) && !seen.has(t)) {
      seen.add(t);
      used.push(t);
    }
  }
  const fq = new Map(used.map((t) => [t, `${byTable.get(t)!.catalog}.${byTable.get(t)!.schema}.${t}`]));

  const mappingLines = mappings.map((m) => {
    if (!m.source_table || !m.source_column) {
      return `  - ${m.target_column}  <-  (no source; emit NULL cast to the target type)`;
    }
    return `  - ${m.target_column}  <-  ${m.source_table}.${m.source_column}`;
  });

  const tablesBlock = used.length ? used.map((t) => `  - ${t}  =  ${fq.get(t)}`).join('\n') : '  (none selected)';

  const system = `You are an expert Databricks SQL engineer. Generate ONE read-only Databricks SQL query (a single SELECT statement, which MAY begin with WITH common table expressions and MAY use subqueries, scalar subqueries, CASE expressions, UNION, and NOT EXISTS / IN filters) that reads from the given source table(s) and produces a result whose columns exactly match the target contract (same column names, types, lengths, nullability).

Hard requirements:
- Output ONLY the SQL statement. No markdown fences, no commentary.
- Use the fully-qualified source table names given below.
- When attributes come from more than one source table, JOIN them. Infer the join keys from matching column names (e.g. shared *_id columns); prefer LEFT JOIN from the primary table (the one supplying the target primary key). If a join key is uncertain, pick the most likely and proceed.
- Alias every output column to the exact target column name, in target ordinal order.
- For target columns with no source, emit NULL CAST to the target type.
- Cast each column to the target type. Valid Spark cast types only: STRING (NOT STRING(n) — Spark STRING has no length; use LEFT(x, n) to enforce a max length), DATE, TIMESTAMP, INT, BIGINT, DOUBLE, BOOLEAN, DECIMAL(p,s). Only DECIMAL takes a length.
- The target runs in ANSI mode: a bad date/number string in a plain CAST/TO_DATE ERRORS the whole query. Use the ERROR-TOLERANT variants for dirty source data — try_to_date / try_to_timestamp / try_cast (they return NULL on bad input) — per the date rules below. Never emit plain CAST(x AS DATE) or TO_DATE on a raw source string.
- The query MUST be read-only: it must start with SELECT or WITH and contain exactly one statement (no semicolon-separated statements). CTEs, subqueries, scalar subqueries, JOINs, CASE, UNION, and EXISTS are all allowed. NEVER emit any DDL or DML or side-effecting command — no INSERT, UPDATE, DELETE, MERGE, UPSERT, CREATE, DROP, ALTER, TRUNCATE, RENAME, GRANT, REVOKE, DENY, COPY, CALL, EXECUTE, EXEC, VACUUM, OPTIMIZE, MSCK, or REPAIR (including inside comments or CTEs).
- Use Databricks SQL (Spark SQL) dialect.
${HEALTHCARE_RULES}`;

  const user = `target entity: ${target.target_table}
Target columns (in order):
${renderTargetColumns(target.columns)}

Source tables (alias name = fully-qualified name):
${tablesBlock}

Source column definitions:
${renderSourceTables(used.map((t) => byTable.get(t)!))}

Attribute mappings to implement (target_column <- source_table.source_column):
${mappingLines.join('\n')}${renderInstructions(instructions)}${renderReferenceContext(referenceContext)}${renderSampleContext(sampleContext)}${renderExamples(examples, limits?.maxExampleSqlChars ?? MAX_EXAMPLE_SQL_CHARS)}${renderPriorSql(priorSql)}

Produce the single read-only query now (SELECT, optionally led by WITH CTEs; when a reference conversion is provided, mirror its query structure).`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Strip markdown fences / stray prose the LLM may add around SQL. */
export function cleanSql(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s.trim().replace(/;\s*$/, '');
}

// Statement-modifying / side-effecting keywords that must never appear in a
// generated query. Deliberately EXCLUDES words that are valid Spark SQL functions
// or plausible unquoted column names (e.g. REPLACE → replace()/regexp_replace(),
// SET, USE, COMMENT, LOAD, GET) to avoid false-rejecting legitimate transformation
// SELECTs. The structural checks below (single-statement, must-start-with-SELECT,
// comment/literal stripping) do the heavy lifting; this list is defense-in-depth.
const BANNED_SQL_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT',
  'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'RENAME',
  'GRANT', 'REVOKE', 'DENY',
  'COPY', 'CALL', 'EXECUTE', 'EXEC',
  'VACUUM', 'OPTIMIZE', 'MSCK', 'REPAIR',
];

/**
 * Defensive check that generated SQL is a single READ-ONLY query.
 *
 * Hardened against bypasses:
 *  - strips `--` line comments and block comments so a keyword can't hide behind one,
 *  - removes string/backtick-quoted literals before keyword scanning, so a banned
 *    word inside a string (e.g. a value "please DELETE") doesn't false-trigger,
 *  - rejects MULTIPLE statements (a `;` separating two statements — a trailing `;`
 *    on a single statement is allowed),
 *  - requires the statement to START with SELECT or WITH,
 *  - rejects ANY banned DDL/DML keyword anywhere in the (comment/literal-stripped) text.
 * Only SELECT/WITH read queries pass.
 */
export function isReadOnlySql(sql: string): boolean {
  if (!sql || !sql.trim()) return false;

  // 1. Strip block comments /* ... */ and line comments -- ... (to end of line).
  let s = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

  // 2. Remove string literals ('...' with '' escapes) and backtick identifiers so
  //    their contents can't trip the keyword scan. Double-quoted identifiers too.
  s = s
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/`[^`]*`/g, '``')
    .replace(/"(?:""|[^"])*"/g, '""');

  const trimmed = s.trim();
  if (!trimmed) return false;

  // 3. Reject multiple statements: split on ';', ignore empties/whitespace. More than
  //    one non-empty segment ⇒ multiple statements (a lone trailing ';' is fine).
  const statements = trimmed.split(';').map((x) => x.trim()).filter(Boolean);
  if (statements.length > 1) return false;

  const upper = (statements[0] ?? trimmed).toUpperCase();

  // 4. Must start with SELECT or WITH (a CTE read).
  if (!(upper.startsWith('SELECT') || upper.startsWith('WITH'))) return false;

  // 5. No banned keyword anywhere (word-boundary matched).
  const banned = new RegExp(`\\b(${BANNED_SQL_KEYWORDS.join('|')})\\b`);
  return !banned.test(upper);
}

/** Extract the first JSON object from an LLM response that may have stray text.
 * Optionally tolerant of output TRUNCATED mid-array (common when the model hits
 * max_tokens on a wide target): with `repair` on (the default), a failed strict parse
 * trims back to the last complete object and closes the outstanding brackets so the
 * mappings gathered so far are still usable.
 *
 * Pass `repair: false` to get a STRICT parse that throws on any malformed output —
 * callers with their own retry should do that first (a fresh generation usually comes
 * back clean and COMPLETE) and only fall back to the tolerant repair once retries are
 * exhausted, so genuinely corrupt (not just truncated) output isn't silently salvaged
 * into a partial result that drops mappings without a retry. */
export function extractJson(raw: string, opts?: { repair?: boolean }): unknown {
  const repair = opts?.repair ?? true;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : raw;
  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in LLM response');
  const body = candidate.slice(start);
  const end = body.lastIndexOf('}');
  if (end !== -1) {
    try { return JSON.parse(body.slice(0, end + 1)); }
    catch (e) { if (!repair) throw e; /* else fall through to repair */ }
  } else if (!repair) {
    throw new Error('No parseable JSON object found in LLM response');
  }
  const repaired = repairTruncatedJson(body);
  if (repaired !== null) return repaired;
  throw new Error('No parseable JSON object found in LLM response');
}

/** Balance a JSON fragment by removing a dangling comma and appending the closers
 * ("]"/"}") for any brackets still open (ignoring brackets inside strings). */
function balanceClose(s: string): string {
  let curly = 0, square = 0, inStr = false, esc = false;
  for (const ch of s) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') curly++;
    else if (ch === '}') curly--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;
  }
  let out = s.replace(/,\s*$/, '');
  while (square-- > 0) out += ']';
  while (curly-- > 0) out += '}';
  return out;
}

/** Recover a truncated JSON object by trimming to the last complete "}" and closing
 * the outstanding brackets; retries a couple of times, stepping back a "}" each time. */
function repairTruncatedJson(body: string): unknown {
  let head = body;
  for (let i = 0; i < 4; i++) {
    const lastObj = head.lastIndexOf('}');
    if (lastObj === -1) return null;
    head = head.slice(0, lastObj + 1);
    try { return JSON.parse(balanceClose(head)); } catch { /* step back another object */ }
    head = head.slice(0, lastObj); // drop the "}" we just tried, retry with the prior one
  }
  return null;
}
