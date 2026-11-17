import { describe, it, expect } from 'vitest';
import { resolveTargetSchemaColumns, rowsToTargetEntities, describeTargetSchemaField } from '../server/aimapper/targetSchema.js';

describe('target-schema validation', () => {
  it('needs only table name, column name and data type', () => {
    expect(resolveTargetSchemaColumns(['target_table', 'target_column', 'data_type']).missing).toEqual([]);
    expect(resolveTargetSchemaColumns(['target_table', 'target_column']).missing).toEqual(['data_type']);
    expect(resolveTargetSchemaColumns(['foo', 'bar']).missing).toEqual(['target_table', 'target_column', 'data_type']);
  });

  it('accepts common alternative names, in any case', () => {
    const r = resolveTargetSchemaColumns(['Table_Name', 'COLUMN_NAME', 'Type', 'Comment', 'Position']);
    expect(r.missing).toEqual([]);
    // Actual (original-case) names are returned, so queries can quote them.
    expect(r.columns).toMatchObject({
      target_table: 'Table_Name',
      target_column: 'COLUMN_NAME',
      data_type: 'Type',
      description: 'Comment',
      ordinal_position: 'Position',
    });
    expect(resolveTargetSchemaColumns(['entity', 'attribute', 'datatype']).missing).toEqual([]);
  });

  it('prefers the canonical name when a table has both', () => {
    const r = resolveTargetSchemaColumns(['table_name', 'target_table', 'target_column', 'data_type']);
    expect(r.columns.target_table).toBe('target_table');
  });

  it('lists the accepted names for a missing field', () => {
    expect(describeTargetSchemaField('data_type')).toMatch(/^data type \(data_type, datatype, type/);
  });
});

describe('rowsToTargetEntities', () => {
  it('fills defaults when only the required columns exist', () => {
    const out = rowsToTargetEntities([
      { target_table: 'member', target_column: 'member_id', data_type: 'STRING' },
      { target_table: 'member', target_column: 'dob', data_type: 'DATE' },
      { target_table: 'claim', target_column: 'claim_id', data_type: 'STRING' },
    ]);
    expect(out.map((t) => t.target_table)).toEqual(['claim', 'member']);
    const member = out[1].columns;
    // Row order becomes the column order.
    expect(member.map((c) => [c.target_column, c.ordinal_position])).toEqual([['member_id', 1], ['dob', 2]]);
    expect(member[0]).toMatchObject({
      is_nullable: true,
      is_primary_key: null,
      data_length: null,
      description: null,
      transform_hint: null,
    });
  });

  it('uses optional columns when present', () => {
    const [t] = rowsToTargetEntities([
      { target_table: 'm', target_column: 'b', data_type: 'INT', ordinal_position: '2', is_nullable: 'false', is_primary_key: 'true', data_length: '10' },
      { target_table: 'm', target_column: 'a', data_type: 'STRING', ordinal_position: '1', is_nullable: 'true', description: 'first' },
    ]);
    expect(t.columns.map((c) => c.target_column)).toEqual(['a', 'b']);
    expect(t.columns[1]).toMatchObject({ ordinal_position: 2, is_nullable: false, is_primary_key: true, data_length: 10 });
    expect(t.columns[0]).toMatchObject({ is_nullable: true, description: 'first' });
  });

  it('reads an information_schema.columns-style table', () => {
    const [t] = rowsToTargetEntities([
      { table_name: 'member', column_name: 'dob', data_type: 'DATE', ordinal_position: '2', is_nullable: 'YES', comment: 'Birth date', character_maximum_length: null },
      { table_name: 'member', column_name: 'member_id', data_type: 'STRING', ordinal_position: '1', is_nullable: 'NO', comment: null, character_maximum_length: '20' },
    ]);
    expect(t.target_table).toBe('member');
    expect(t.columns.map((c) => c.target_column)).toEqual(['member_id', 'dob']);
    expect(t.columns[0]).toMatchObject({ is_nullable: false, data_length: 20 });
    expect(t.columns[1]).toMatchObject({ is_nullable: true, description: 'Birth date' });
  });

  it('orders by 0-based or gapped positions and numbers columns 1..n', () => {
    const [t] = rowsToTargetEntities([
      { table_name: 'm', column_name: 'c', data_type: 'INT', ordinal_position: '20' },
      { table_name: 'm', column_name: 'none', data_type: 'INT', ordinal_position: null },
      { table_name: 'm', column_name: 'a', data_type: 'INT', ordinal_position: '0' },
      { table_name: 'm', column_name: 'b', data_type: 'INT', ordinal_position: '10' },
    ]);
    expect(t.columns.map((c) => `${c.target_column}:${c.ordinal_position}`)).toEqual(['a:1', 'b:2', 'c:3', 'none:4']);
  });

  it('matches column names case-insensitively and skips rows without names', () => {
    const [t, ...rest] = rowsToTargetEntities([
      { Target_Table: 'm', TARGET_COLUMN: 'x', Data_Type: 'STRING', IS_NULLABLE: 'N' },
      { Target_Table: 'm', TARGET_COLUMN: null, Data_Type: 'STRING' },
      { Target_Table: ' ', TARGET_COLUMN: 'y', Data_Type: 'STRING' },
    ]);
    expect(rest).toEqual([]);
    expect(t.columns).toHaveLength(1);
    expect(t.columns[0]).toMatchObject({ target_column: 'x', is_nullable: false });
  });

  it('defaults an empty data type to STRING', () => {
    const [t] = rowsToTargetEntities([{ target_table: 'm', target_column: 'x', data_type: '' }]);
    expect(t.columns[0].data_type).toBe('STRING');
  });
});
