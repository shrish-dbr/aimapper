// [DATA-SAMPLING] Optional per-run source-data sampling to improve mapping accuracy.
//
// This whole FILE is the sampling feature's server logic. It is self-contained on
// purpose: to REMOVE the feature entirely, delete this file and the handful of
// call sites tagged `[DATA-SAMPLING]` elsewhere (see docs/data-sampling-feature.md).
//
// What it does: for the source tables actually used by a mapping, it reads a small,
// cheap LIMIT sample and distills a few ACTUAL distinct values (+ null/empty rate)
// per column into a compact text block that is injected into the SQL-generation
// prompt. This lets the model see real formats/encodings (date patterns, codes,
// casing, identifier/currency formatting) instead of guessing from types alone.
//
// PRIVACY NOTE: this sends real source-data values (which for EHR sources includes
// PHI) to the LLM serving endpoint. It is OFF by default and enabled per-run by the
// caller. No column masking is applied here (a deliberate choice for now) and the
// samples are NEVER persisted — they exist only in the transient prompt.
import type { SourceTable } from './types.js';

// Tunables — kept conservative to bound cost, latency, and token usage.
export const MIN_SAMPLE_ROWS = 50;     // floor on rows scanned per table (cheap LIMIT, no full scan)
export const DEFAULT_SAMPLE_VALUES = 3; // distinct example values shown per column (the token driver)
export const MIN_SAMPLE_VALUES = 1;
export const MAX_SAMPLE_VALUES = 100;
export const MAX_VALUE_CHARS = 60;     // per-value truncation (blobs/notes can't blow up the prompt)
export const SAMPLE_CHAR_BUDGET = 40000; // overall cap on the rendered block (~10k tokens; bounds high sample sizes)

/** Clamp a requested values-per-column count into the allowed range. The ceiling
 * defaults to MAX_SAMPLE_VALUES but the Prompt Sizing profile can lower/raise it. */
export function clampSampleValues(n: number | undefined, ceiling: number = MAX_SAMPLE_VALUES): number {
  const cap = Math.max(MIN_SAMPLE_VALUES, ceiling);
  if (typeof n !== 'number' || Number.isNaN(n)) return Math.min(DEFAULT_SAMPLE_VALUES, cap);
  return Math.min(cap, Math.max(MIN_SAMPLE_VALUES, Math.round(n)));
}

// Columns whose type carries little useful "format" signal but lots of tokens/PHI —
// skip them from sampling.
const COMPLEX_TYPE = /^(struct|array|map|binary|interval|variant)/i;

type QueryRunner = (sql: string) => Promise<Record<string, string | null>[]>;

/**
 * Build the source-data sample block for the given tables, or '' if nothing useful
 * could be sampled. Best-effort: any table that can't be read (permissions, missing,
 * empty) is skipped silently so a sampling problem never fails the mapping run.
 *
 * `runQuery` must execute on-behalf-of the current user so UC permissions (and any
 * UC column masks / row filters) apply to the sampled data automatically.
 *
 * `valuesPerColumn` (the per-run "sample size") sets how many distinct example
 * values are shown per column — this is what scales token usage.
 */
export async function buildSampleContext(
  runQuery: QueryRunner,
  tables: SourceTable[],
  valuesPerColumn: number = DEFAULT_SAMPLE_VALUES,
  opts?: { charBudget?: number; maxValueChars?: number; maxValues?: number }, // Prompt Sizing profile caps (optional; default to the module consts)
): Promise<string> {
  const charBudget = opts?.charBudget ?? SAMPLE_CHAR_BUDGET;
  const maxValueChars = opts?.maxValueChars ?? MAX_VALUE_CHARS;
  const perCol = clampSampleValues(valuesPerColumn, opts?.maxValues ?? MAX_SAMPLE_VALUES);
  // Scan enough rows to plausibly find `perCol` distinct values, with a cheap floor.
  const scanRows = Math.max(MIN_SAMPLE_ROWS, perCol * 10);
  const blocks: string[] = [];
  for (const t of tables) {
    const fq = `${t.catalog}.${t.schema}.${t.table}`;
    let rows: Record<string, string | null>[];
    try {
      // fq is a UC identifier and scanRows is a bounded int — safe to interpolate.
      rows = await runQuery(`SELECT * FROM ${fq} LIMIT ${scanRows}`);
    } catch {
      continue; // unreadable / no permission / missing — skip this table
    }
    if (rows.length === 0) continue;

    const lines: string[] = [];
    for (const col of t.columns) {
      if (COMPLEX_TYPE.test(col.typeName)) continue;
      const values = rows.map((r) => r[col.name]);
      const nonNull = values.filter((v) => v != null && v !== '');
      const nullRate = Math.round(((values.length - nonNull.length) / values.length) * 100);

      // Distinct non-null values, first-seen order, truncated per value.
      const distinct: string[] = [];
      for (const v of nonNull) {
        const s = String(v).replace(/\s+/g, ' ').trim().slice(0, maxValueChars);
        if (s && !distinct.includes(s)) distinct.push(s);
        if (distinct.length >= perCol) break;
      }
      const examples = distinct.length
        ? distinct.map((v) => `'${v}'`).join(', ')
        : '(no non-null values sampled)';
      lines.push(`  - ${col.name}: ${examples}${nullRate > 0 ? ` [${nullRate}% null/empty]` : ''}`);
    }
    if (lines.length) blocks.push(`### ${t.table} (from ${rows.length} sampled row(s)):\n${lines.join('\n')}`);
  }

  if (blocks.length === 0) return '';
  let out = blocks.join('\n\n');
  if (out.length > charBudget) out = out.slice(0, charBudget) + '\n… (samples truncated)';
  return out;
}
