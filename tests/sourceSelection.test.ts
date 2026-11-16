import { describe, it, expect } from 'vitest';
import {
  batchSourceTables,
  mapWithConcurrency,
  mergeBatchMappings,
  rankSourceTables,
  renderedTableChars,
} from '../server/aimapper/sourceSelection.js';
import type { TargetEntity, SourceTable } from '../server/aimapper/types.js';

const col = (name: string) => ({ name, typeName: 'STRING', nullable: true, position: 0 });
const tbl = (table: string, cols: string[]): SourceTable => ({ catalog: 'c', schema: 's', table, columns: cols.map(col) });

const target: TargetEntity = {
  target_table: 'clinical_encounter',
  columns: ['encounter_id', 'patient_class_code', 'patient_class_description', 'admission_date', 'discharge_date'].map(
    (target_column, i) => ({ target_table: 'clinical_encounter', target_column, data_type: 'STRING', data_length: 20, is_nullable: true, ordinal_position: i + 1, numeric_precision: null, numeric_scale: null, is_primary_key: null, description: null, transform_hint: null }), // reconstructed: tail after ordinal_position cut off
  ),
};

const noise = Array.from({ length: 60 }, (_, i) => tbl(`noise_${i}`, Array.from({ length: 30 }, (_, j) => `FOO_${i}_${j}`)));
const core = tbl('incr_cv_pat_enc_hsp', ['PAT_ENC_CSN_ID', 'ADT_PAT_CLASS_C', 'HOSP_ADMSN_TIME', 'HOSP_DISCH_TIME', ...Array.from({ length: 30 }, (_, j) => `EXTRA_COL_${j}`)]); // reconstructed: filler column names cut off
const dup = tbl('pat_enc_hsp', core.columns.map((c) => c.name));
const lookup = tbl('zc_pat_class', ['ADT_PAT_CLASS_C', 'NAME', 'TITLE', 'ABBR', 'INTERNAL_ID']);

describe('rankSourceTables', () => {
  it('keeps everything when the selection already fits', () => {
    const r = rankSourceTables(target, [core, lookup], 40);
    expect(r.kept).toHaveLength(2);
    expect(r.skipped).toHaveLength(0);
  });

  it('pre-filters a large selection, keeps the relevant table, collapses duplicates, adds lookups', () => {
    const r = rankSourceTables(target, [...noise, dup, core, lookup], 10);
    const kept = r.kept.map((s) => s.table);
    expect(kept).toContain('incr_cv_pat_enc_hsp');
    expect(kept).not.toContain('pat_enc_hsp'); // near-duplicate collapsed to the prefixed copy
    expect(kept).toContain('zc_pat_class'); // joined lookup added via ADT_PAT_CLASS_C
    expect(r.skipped.length).toBeGreaterThan(0);
  });

  it('always keeps feedback-confirmed tables', () => {
    const r = rankSourceTables(target, [...noise, core], 5, ['noise_59']);
    expect(r.kept.map((s) => s.table)).toContain('noise_59');
  });
});

describe('batchSourceTables', () => {
  it('packs tables under the char budget', () => {
    const budget = renderedTableChars(noise[0]) * 3 + 1;
    const batches = batchSourceTables(noise.slice(0, 10), budget);
    expect(batches.length).toBe(4);
    for (const b of batches) expect(b.reduce((n, s) => n + renderedTableChars(s), 0)).toBeLessThanOrEqual(budget);
  });
});

describe('mergeBatchMappings', () => {
  it('keeps the highest-confidence mapped pick per target column', () => {
    const m = mergeBatchMappings(['a', 'b'], [
      [{ target_column: 'a', source_table: 't1', source_column: 'x', confidence: 0.7, rationale: '' }, { target_column: 'b', source_table: null, source_column: null, confidence: 0, rationale: '' }], // reconstructed: tail of 'b' entry cut off
      [{ target_column: 'a', source_table: 't2', source_column: 'y', confidence: 0.9, rationale: '' }],
    ]);
    expect(m[0].source_table).toBe('t2');
    expect(m[1].source_table).toBeNull();
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order', async () => {
    const out = await mapWithConcurrency([30, 10, 20], 2, async (x) => { await new Promise((r) => setTimeout(r, x)); return x * 2; });
    expect(out).toEqual([60, 20, 40]);
  });
});
