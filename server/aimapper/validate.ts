// Diff a dry-run result schema against the target contract.
import type { ColumnDiff, TargetColumn, ValidationReport } from './types.js';

/** A column from the dry-run result manifest (Statement Execution). */
export interface ResultColumn {
  name: string;
  typeName: string; // STRING, INT, DATE, DECIMAL, ...
  typeText?: string; // e.g. decimal(10,2)
}

const TYPE_MAP: Record<string, string> = {
  VARCHAR: 'STRING',
  CHAR: 'STRING',
  TEXT: 'STRING',
  INTEGER: 'INT',
  BIGINT: 'LONG',
  LONG: 'LONG',
  SHORT: 'INT',
  SMALLINT: 'INT',
  BYTE: 'INT',
  TINYINT: 'INT',
  DOUBLE: 'DOUBLE',
  FLOAT: 'FLOAT',
  REAL: 'FLOAT',
  DEC: 'DECIMAL',
  NUMERIC: 'DECIMAL',
  TIMESTAMP_NTZ: 'TIMESTAMP',
};
const NUMERIC = new Set(['INT', 'LONG', 'DOUBLE', 'FLOAT', 'DECIMAL']);

function canonicalType(t: string): string {
  const up = t.toUpperCase().replace(/\(.*$/, '').trim();
  return TYPE_MAP[up] ?? up;
}

/** Are two types compatible enough for the mapping to be valid? */
function typesCompatible(expected: string, actual: string): boolean {
  const e = canonicalType(expected);
  const a = canonicalType(actual);
  if (e === a) return true;
  return NUMERIC.has(e) && NUMERIC.has(a); // numeric widening ok
}

/** Per-column diff of the generated SELECT's result schema vs the target contract. */
export function diffSchema(targetSchemaCols: TargetColumn[], resultCols: ResultColumn[]): ColumnDiff[] {
  const diffs: ColumnDiff[] = [];
  const byName = new Map(resultCols.map((c) => [c.name.toLowerCase(), c]));
  const targetSchemaNames = new Set(targetSchemaCols.map((c) => c.target_column.toLowerCase()));

  for (const pc of targetSchemaCols.slice().sort((a, b) => a.ordinal_position - b.ordinal_position)) {
    const rc = byName.get(pc.target_column.toLowerCase());
    if (!rc) {
      diffs.push({
        target_column: pc.target_column,
        status: 'missing',
        expected: pc.data_type,
        detail: 'Target column not produced by the generated SQL',
      });
      continue;
    }
    const actualDisp = rc.typeText ?? rc.typeName;
    if (!typesCompatible(pc.data_type, rc.typeName)) {
      diffs.push({
        target_column: pc.target_column,
        status: 'type_mismatch',
        expected: pc.data_type,
        actual: actualDisp,
        detail: `Expected ${pc.data_type}, got ${actualDisp}`,
      });
      continue;
    }
    diffs.push({ target_column: pc.target_column, status: 'matched', expected: pc.data_type, actual: actualDisp });
  }

  for (const rc of resultCols) {
    if (!targetSchemaNames.has(rc.name.toLowerCase())) {
      diffs.push({
        target_column: rc.name,
        status: 'extra',
        actual: rc.typeText ?? rc.typeName,
        detail: 'Column produced but not defined in target',
      });
    }
  }
  return diffs;
}

/** Roll per-column diffs (plus compile result) into an overall report. */
export function buildReport(compiles: boolean, diffs: ColumnDiff[], errorMessage?: string): ValidationReport {
  if (!compiles) {
    return { status: 'FAILED', compiles: false, errorMessage, columns: diffs };
  }
  const hardError = diffs.some((d) => d.status === 'missing' || d.status === 'type_mismatch');
  const warning = diffs.some((d) => d.status === 'extra' || d.status === 'nullability_mismatch');
  const status = hardError ? 'FAILED' : warning ? 'WARNINGS' : 'SUCCESS';
  return { status, compiles: true, errorMessage, columns: diffs };
}
