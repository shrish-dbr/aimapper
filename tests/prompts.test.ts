import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { buildAttributeMatchPrompt, buildJoinSqlPrompt, isReadOnlySql, extractJson, MAX_EXAMPLE_SQL_CHARS } from '../server/aimapper/prompts.js';
import type { AttributeMapping, MappingExample, TargetEntity, SourceTable } from '../server/aimapper/types.js';

// The real customer reference: the stored `claim` example pulled verbatim from the
// retrieval corpus (multi-CTE, inline subqueries, window fns, 5-way UNION ALL, ~26 KB).
const CUSTOMER_SQL = readFileSync(new URL('./fixtures/customer-claim.sql', import.meta.url), 'utf8');

const target: TargetEntity = {
  target_table: 'member',
  columns: [
    {
      target_table: 'member', target_column: 'member_id', ordinal_position: 1, data_type: 'STRING',
      data_length: null, numeric_precision: null, numeric_scale: null, is_nullable: false,
      is_primary_key: true, description: null, transform_hint: null,
    },
    {
      target_table: 'member', target_column: 'gender', ordinal_position: 2, data_type: 'STRING',
      data_length: 1, numeric_precision: null, numeric_scale: null, is_nullable: true,
      is_primary_key: false, description: null, transform_hint: null,
    },
  ],
};

const sources: SourceTable[] = [
  {
    catalog: 'c', schema: 's', table: 'enrollee',
    columns: [
      { name: 'enrollee_id', typeName: 'STRING', nullable: false, position: 1 },
      { name: 'sex', typeName: 'STRING', nullable: true, position: 2 },
    ],
  },
];

const mappings: AttributeMapping[] = [
  { target_column: 'member_id', source_table: 'enrollee', source_column: 'enrollee_id', confidence: 0.95, rationale: '' },
  { target_column: 'gender', source_table: 'enrollee', source_column: 'sex', confidence: 0.8, rationale: '' },
];

const REF = 'The enrollee.sex column uses codes 1=male, 2=female, 9=unknown.';

describe('reference-context injection', () => {
  it('injects the reference block into the attribute-match prompt when provided', () => {
    const msgs = buildAttributeMatchPrompt(target, sources, 0.6, undefined, REF);
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).toContain('Reference documentation');
    expect(user).toContain(REF);
  });

  it('omits the reference block when no context is provided', () => {
    const msgs = buildAttributeMatchPrompt(target, sources, 0.6);
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).not.toContain('Reference documentation');
  });

  it('omits the reference block for empty / whitespace context', () => {
    const msgs = buildAttributeMatchPrompt(target, sources, 0.6, undefined, '   ');
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).not.toContain('Reference documentation');
  });

  it('injects the reference block into the join-SQL prompt when provided', () => {
    const msgs = buildJoinSqlPrompt(target, sources, mappings, undefined, REF);
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).toContain('Reference documentation');
    expect(user).toContain(REF);
  });

  it('omits the reference block from the join-SQL prompt when not provided', () => {
    const msgs = buildJoinSqlPrompt(target, sources, mappings);
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).not.toContain('Reference documentation');
  });
});

describe('source-system mapping instructions injection', () => {
  const INSTR = 'Prefer patient_master over patient_staging; dates are MM/DD/YYYY.';

  it('injects the renamed "Source system mapping instructions" block into the match prompt', () => {
    const msgs = buildAttributeMatchPrompt(target, sources, 0.6, undefined, undefined, INSTR);
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).toContain('Source system mapping instructions');
    expect(user).toContain(INSTR);
    // The old "Domain mapping instructions" label must be gone.
    expect(user).not.toContain('Domain mapping instructions');
  });

  it('injects the instructions block into the join-SQL prompt', () => {
    const msgs = buildJoinSqlPrompt(target, sources, mappings, undefined, undefined, INSTR);
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).toContain('Source system mapping instructions');
    expect(user).toContain(INSTR);
  });

  it('omits the instructions block when none is provided', () => {
    const msgs = buildJoinSqlPrompt(target, sources, mappings);
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).not.toContain('Source system mapping instructions');
  });
});

describe('large complex example is injected into the prompt in FULL (200k cap, no 2000-char clip)', () => {
  // Reproduces a customer-style reference: many CTEs, an inline subquery, a window
  // function, and an UNPIVOT — with a unique marker placed at the very END so we can
  // prove the tail survives (the old bug embedded/clipped only the first 2000 chars).
  const END_MARKER = 'END_MARKER_UNIQUE_7f3a9c';
  function complexExampleSql(cteCount: number): string {
    const ctes = Array.from({ length: cteCount }, (_, i) =>
      `cte_${i} AS (\n` +
      `  SELECT id, val_${i}, ROW_NUMBER() OVER (PARTITION BY id ORDER BY ts DESC) AS rn\n` +
      `  FROM (SELECT * FROM src_${i} WHERE flag = 1) inline_${i}\n` +
      `)`,
    );
    const joins = ctes
      .map((_, i) => (i === 0 ? '' : `LEFT JOIN cte_${i} c${i} ON c${i}.id = c0.id AND c${i}.rn = 1`))
      .filter(Boolean)
      .join('\n');
    return (
      `-- CUSTOMER MAPPING: multi-CTE + inline subquery + window fn + UNPIVOT\n` +
      `WITH ${ctes.join(',\n')},\n` +
      `unpivoted AS (\n` +
      `  SELECT id, metric_name, metric_value\n` +
      `  FROM wide_metrics\n` +
      `  UNPIVOT (metric_value FOR metric_name IN (m1, m2, m3, m4, m5))\n` +
      `)\n` +
      `SELECT c0.id AS member_id, u.metric_value AS gender  -- ${END_MARKER}\n` +
      `FROM cte_0 c0\n${joins}\n` +
      `LEFT JOIN unpivoted u ON u.id = c0.id\nWHERE c0.rn = 1`
    );
  }

  function exampleFrom(sql: string): MappingExample {
    return {
      example_id: 'example:customer-1', target_table: 'member', source_signature: 'cust.raw.claims',
      source_columns: null, generated_sql: sql, notes: 'customer reference', approved: true,
      created_by: null, created_at: '',
    };
  }

  it('injects the REAL customer claim example (~26 KB) into the prompt, verbatim and untruncated', () => {
    // Guard the fixture: it must be well past the old 2000-char clip, and its
    // distinctive structure must live far beyond that boundary.
    expect(CUSTOMER_SQL.length).toBeGreaterThan(20000);
    expect(CUSTOMER_SQL.indexOf('xUnionValues')).toBeGreaterThan(2000);

    const msgs = buildJoinSqlPrompt(target, sources, mappings, [exampleFrom(CUSTOMER_SQL)]);
    const user = msgs.find((m) => m.role === 'user')!.content;

    expect(user).toContain('Reference conversions');
    // The whole statement, byte-for-byte — this is the core assertion.
    expect(user).toContain(CUSTOMER_SQL);
    // Spot-check landmarks spread from head to tail (all would vanish under a 2000-char clip):
    expect(user).toContain('memberFilter');            // first CTE
    expect(user).toContain('clm_ranked');              // ranking CTE
    expect(user).toContain('providerEnriched');        // enrichment CTE
    // All five UNION legs are present.
    expect(user.match(/UNION ALL/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(user).toContain('source_system_timestamp'); // final SELECT tail
  });

  it('injects a synthetic large multi-CTE + UNPIVOT example in full (tail past char 2000)', () => {
    const sql = complexExampleSql(150);
    expect(sql.length).toBeGreaterThan(20000);
    expect(sql.indexOf(END_MARKER)).toBeGreaterThan(2000);

    const msgs = buildJoinSqlPrompt(target, sources, mappings, [exampleFrom(sql)]);
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).toContain(sql);
    expect(user).toContain('UNPIVOT');
    expect(user).toContain(END_MARKER);
  });

  it('preserves an example right up to the 200k per-example cap', () => {
    // Grow the example close to — but under — the cap; it must appear untouched.
    let sql = complexExampleSql(2);
    while (sql.length < MAX_EXAMPLE_SQL_CHARS - 5000) sql = complexExampleSql(2) + '\n' + sql;
    expect(sql.length).toBeLessThan(MAX_EXAMPLE_SQL_CHARS);

    const msgs = buildJoinSqlPrompt(target, sources, mappings, [exampleFrom(sql)]);
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).toContain(sql);
    expect(user).toContain(END_MARKER);
  });

  it('caps a single example at 200k chars (documents the only truncation point)', () => {
    const huge = 'X'.repeat(MAX_EXAMPLE_SQL_CHARS + 50000) + END_MARKER;
    const msgs = buildJoinSqlPrompt(target, sources, mappings, [exampleFrom(huge)]);
    const user = msgs.find((m) => m.role === 'user')!.content;
    // Everything up to the cap is present; the overflow tail is dropped.
    expect(user).toContain('X'.repeat(1000));
    expect(user).not.toContain(END_MARKER);
  });
});

describe('isReadOnlySql — only SELECT/WITH reads pass', () => {
  it('allows plain SELECT and CTE reads', () => {
    expect(isReadOnlySql('SELECT * FROM t')).toBe(true);
    expect(isReadOnlySql('  select a, b from t where x > 1')).toBe(true);
    expect(isReadOnlySql('WITH c AS (SELECT 1) SELECT * FROM c')).toBe(true);
    expect(isReadOnlySql('SELECT * FROM t;')).toBe(true); // trailing semicolon ok
  });

  it('allows SELECTs using functions whose names resemble keywords', () => {
    expect(isReadOnlySql("SELECT replace(x, 'a', 'b') FROM t")).toBe(true);
    expect(isReadOnlySql("SELECT regexp_replace(x, '[^0-9]', '') AS n FROM t")).toBe(true);
    expect(isReadOnlySql('SELECT set_col, use_col, comment FROM t')).toBe(true); // column names
  });

  it('rejects DDL/DML', () => {
    for (const s of [
      'DROP TABLE t', 'DELETE FROM t', 'UPDATE t SET a=1', 'INSERT INTO t VALUES (1)',
      'MERGE INTO t USING s ON t.id=s.id', 'CREATE TABLE t AS SELECT 1', 'ALTER TABLE t ADD COLUMNS (x INT)',
      'TRUNCATE TABLE t', 'GRANT SELECT ON t TO u', 'VACUUM t', 'OPTIMIZE t',
    ]) {
      expect(isReadOnlySql(s), s).toBe(false);
    }
  });

  it('rejects multiple statements and comment/keyword bypasses', () => {
    expect(isReadOnlySql('SELECT 1; DROP TABLE t')).toBe(false);       // multi-statement
    expect(isReadOnlySql('SELECT 1;\nDELETE FROM t')).toBe(false);
    expect(isReadOnlySql('-- SELECT\nDROP TABLE t')).toBe(false);      // comment then DDL
    expect(isReadOnlySql('/* SELECT */ DROP TABLE t')).toBe(false);    // block comment then DDL
    expect(isReadOnlySql('')).toBe(false);
    expect(isReadOnlySql('   ')).toBe(false);
  });

  it('does not false-trigger on banned words inside string literals', () => {
    expect(isReadOnlySql("SELECT 'please do not DELETE this' AS note FROM t")).toBe(true);
    expect(isReadOnlySql("SELECT col AS \"drop_reason\" FROM t")).toBe(true);
  });
});

describe('extractJson — tolerant of truncated / fenced LLM output', () => {
  it('parses clean JSON and JSON inside code fences', () => {
    expect(extractJson('{"mappings":[{"target_column":"a"}]}')).toEqual({ mappings: [{ target_column: 'a' }] });
    expect(extractJson('```json\n{"x":1}\n```')).toEqual({ x: 1 });
  });

  it('recovers mappings from a response truncated mid-array (max_tokens hit)', () => {
    // Simulates the real failure: valid objects, then the array is cut off mid-element.
    const truncated =
      '{"target_table":"t","mappings":[' +
      '{"target_column":"a","source_column":"x","confidence":0.9},' +
      '{"target_column":"b","source_column":"y","confidence":0.8},' +
      '{"target_column":"c","source_col';
    const parsed = extractJson(truncated) as { mappings: { target_column: string }[] };
    // The two complete objects survive; the partial one is dropped.
    expect(parsed.mappings.map((m) => m.target_column)).toEqual(['a', 'b']);
  });

  it('throws a clear error when there is no JSON object at all', () => {
    expect(() => extractJson('the model refused to answer')).toThrow(/JSON/);
  });

  it('with { repair: false } throws on truncated output instead of salvaging a partial', () => {
    // Callers with their own retry pass repair:false so a truncated/corrupt response is
    // regenerated (usually complete) rather than silently reduced to a partial mapping set.
    const truncated =
      '{"target_table":"t","mappings":[' +
      '{"target_column":"a","source_column":"x","confidence":0.9},' +
      '{"target_column":"c","source_col';
    expect(() => extractJson(truncated, { repair: false })).toThrow();
    // Clean output still parses under strict mode.
    expect(extractJson('{"x":1}', { repair: false })).toEqual({ x: 1 });
  });
});
