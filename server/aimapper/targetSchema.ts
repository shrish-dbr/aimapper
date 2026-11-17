// Reading a target-schema table into the target contract.
//
// Any Unity Catalog table can serve as a target schema as long as it has one row per
// target column with the target table name, column name and data type. Each field is
// recognised under several common column names (e.g. `table_name` or `entity` for the
// table name), so catalogue-style tables and `information_schema.columns` work as is.
// Every other field is optional; when a table doesn't have it, a neutral default is
// used. Pure (no I/O) so it can be unit-tested.

import type { TargetColumn, TargetEntity } from './types.js';

/**
 * Accepted column names per field, case-insensitive. The first name present in a table
 * wins, so the canonical name (listed first) beats an alternative if a table has both.
 */
export const TARGET_SCHEMA_FIELDS = {
  // Required
  target_table: ['target_table', 'table_name', 'target_entity', 'entity', 'entity_name', 'table'],
  target_column: ['target_column', 'column_name', 'attribute', 'attribute_name', 'field_name', 'field', 'column'],
  data_type: ['data_type', 'datatype', 'type', 'type_name', 'column_type'],
  // Optional
  ordinal_position: ['ordinal_position', 'position', 'column_position', 'ordinal', 'column_order', 'sort_order'],
  data_length: ['data_length', 'length', 'max_length', 'character_maximum_length'],
  numeric_precision: ['numeric_precision', 'precision'],
  numeric_scale: ['numeric_scale', 'scale'],
  is_nullable: ['is_nullable', 'nullable'],
  is_primary_key: ['is_primary_key', 'primary_key', 'is_pk', 'pk'],
  description: ['description', 'comment', 'column_description', 'definition'],
  transform_hint: ['transform_hint', 'transformation', 'transform_rule', 'mapping_rule'],
} as const;

export type TargetSchemaField = keyof typeof TARGET_SCHEMA_FIELDS;

/** Fields a target-schema table must have (checked when a version is saved). */
export const REQUIRED_TARGET_SCHEMA_FIELDS = ['target_table', 'target_column', 'data_type'] as const satisfies readonly TargetSchemaField[];

/**
 * Map each field to the table's actual column name (original case), using the first
 * accepted name the table has. `missing` lists required fields with no match.
 */
export function resolveTargetSchemaColumns(columnNames: Iterable<string>): {
  columns: Partial<Record<TargetSchemaField, string>>;
  missing: TargetSchemaField[];
} {
  const byLower = new Map<string, string>();
  for (const c of columnNames) if (!byLower.has(c.toLowerCase())) byLower.set(c.toLowerCase(), c);
  const columns: Partial<Record<TargetSchemaField, string>> = {};
  for (const field of Object.keys(TARGET_SCHEMA_FIELDS) as TargetSchemaField[]) {
    const hit = TARGET_SCHEMA_FIELDS[field].find((name) => byLower.has(name));
    if (hit) columns[field] = byLower.get(hit)!;
  }
  return { columns, missing: REQUIRED_TARGET_SCHEMA_FIELDS.filter((f) => !columns[f]) };
}

/** "table name (target_table, table_name, …)" — for messages about a missing field. */
export function describeTargetSchemaField(field: TargetSchemaField): string {
  const label = { target_table: 'table name', target_column: 'column name', data_type: 'data type' }[field as string] ?? field;
  return `${label} (${TARGET_SCHEMA_FIELDS[field].join(', ')})`;
}

/** A query result row: column name → value (the SQL API returns every value as text). */
type Row = Record<string, string | null | undefined>;

const str = (v: string | null | undefined): string | null => v ?? null;
const intOrNull = (v: string | null | undefined): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const boolOrNull = (v: string | null | undefined): boolean | null => {
  if (v == null || v === '') return null;
  const s = v.trim().toLowerCase();
  if (['true', 't', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'f', 'no', 'n', '0'].includes(s)) return false;
  return null;
};

/**
 * Group target-schema rows (from `SELECT *`) into target entities.
 *
 * Columns are found by any accepted name (see TARGET_SCHEMA_FIELDS). Rows without a
 * table or column name are skipped. Columns are ordered by position when the table has
 * one, otherwise in row order. A missing or empty nullability counts as nullable (no
 * NOT NULL check).
 */
export function rowsToTargetEntities(rows: Row[]): TargetEntity[] {
  const names = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) names.add(k);
  const { columns: col } = resolveTargetSchemaColumns(names);
  const get = (r: Row, f: TargetSchemaField) => (col[f] ? r[col[f]] : undefined);

  const byTable = new Map<string, { c: TargetColumn; pos: number | null; seq: number }[]>();
  rows.forEach((r, seq) => {
    const table = str(get(r, 'target_table'))?.trim();
    const column = str(get(r, 'target_column'))?.trim();
    if (!table || !column) return;
    const c: TargetColumn = {
      target_table: table,
      target_column: column,
      ordinal_position: 0, // set below, once the table's columns are ordered
      data_type: str(get(r, 'data_type'))?.trim() || 'STRING',
      data_length: intOrNull(get(r, 'data_length')),
      numeric_precision: intOrNull(get(r, 'numeric_precision')),
      numeric_scale: intOrNull(get(r, 'numeric_scale')),
      // Without the column (or a readable value) there's no NOT NULL rule to enforce.
      is_nullable: boolOrNull(get(r, 'is_nullable')) ?? true,
      is_primary_key: boolOrNull(get(r, 'is_primary_key')),
      description: str(get(r, 'description')),
      transform_hint: str(get(r, 'transform_hint')),
    };
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table)!.push({ c, pos: intOrNull(get(r, 'ordinal_position')), seq });
  });
  return [...byTable.entries()]
    .map(([target_table, cols]) => {
      // Order by the table's positions (0- or 1-based, gaps allowed); columns without one
      // go last, in row order. Then number them 1..n — the app only relies on the order.
      const sorted = [...cols].sort((a, b) => (a.pos ?? Infinity) - (b.pos ?? Infinity) || a.seq - b.seq);
      const columns = sorted.map(({ c }, i) => ({ ...c, ordinal_position: i + 1 }));
      return { target_table, columns };
    })
    .sort((a, b) => a.target_table.localeCompare(b.target_table));
}
