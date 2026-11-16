import { describe, it, expect } from 'vitest';
import {
  buildReferenceChunkSql,
  buildReferenceQueries,
  packReferenceChunks,
  chunkLabel,
  COLUMNS_PER_QUERY,
  MAX_REFERENCE_QUERIES,
  type ReferenceChunk,
} from '../server/aimapper/references.js';

const chunk = (id: string, score: number, len: number, extra: Partial<ReferenceChunk> = {}): ReferenceChunk => ({
  chunk_id: id,
  file_name: 'Epic_PATIENT.pdf',
  page_start: 2,
  page_end: 2,
  heading: 'Column Information',
  content: 'x'.repeat(len),
  score,
  ...extra,
});

describe('buildReferenceQueries', () => {
  it('splits wide targets into column groups so every column is covered', () => {
    const cols = Array.from({ length: 40 }, (_, i) => `col_${i}`);
    const qs = buildReferenceQueries('member', cols, ['PAT_ID']);
    expect(qs).toHaveLength(Math.ceil(40 / COLUMNS_PER_QUERY));
    expect(qs[0]).toContain('"member" target');
    expect(qs[0]).toContain('col_0');
    expect(qs[2]).toContain('col_39');
    expect(qs.every((q) => q.includes('Source columns: PAT_ID'))).toBe(true);
  });

  it('caps the number of queries and still emits one when there are no columns', () => {
    const cols = Array.from({ length: 500 }, (_, i) => `c${i}`);
    expect(buildReferenceQueries('claim', cols, [])).toHaveLength(MAX_REFERENCE_QUERIES);
    expect(buildReferenceQueries('claim', [], [])).toHaveLength(1);
  });
});

describe('packReferenceChunks', () => {
  it('packs whole chunks best-first and never exceeds the budget', () => {
    const results = [[chunk('a', 0.9, 900), chunk('b', 0.8, 900), chunk('c', 0.7, 900)]];
    const { text, sources } = packReferenceChunks(results, 2000);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(sources.map((s) => s.score)).toEqual([0.9, 0.8]);
    // Each included chunk is complete (900 x's), not truncated.
    expect(text.match(/x{900}/g)).toHaveLength(2);
  });

  it('skips a chunk that does not fit but still adds smaller lower-ranked ones', () => {
    const results = [[chunk('big', 0.9, 1800), chunk('small', 0.5, 200)]];
    const { sources } = packReferenceChunks(results, 1000);
    expect(sources).toHaveLength(1);
    expect(sources[0].chars).toBe(200);
  });

  it('dedupes chunks returned by several queries, keeping the best score', () => {
    const { sources, candidates } = packReferenceChunks([[chunk('a', 0.6, 100)], [chunk('a', 0.95, 100), chunk('b', 0.7, 100)]], 10_000);
    expect(candidates).toBe(2);
    expect(sources.map((s) => s.score)).toEqual([0.95, 0.7]);
  });

  it('returns empty when nothing is retrieved', () => {
    expect(packReferenceChunks([[], []], 5000)).toEqual({ text: '', sources: [], candidates: 0 });
  });
});

describe('chunkLabel', () => {
  it('labels file, page range and section', () => {
    expect(chunkLabel({ file_name: 'a.pdf', page_start: 3, page_end: 4, heading: 'Codes' })).toBe('[a.pdf p.3–4 · Codes]');
    expect(chunkLabel({ file_name: 'a.pdf', page_start: 3, page_end: 3, heading: null })).toBe('[a.pdf p.3]');
  });
});

describe('buildReferenceChunkSql', () => {
  it('parses one file, or a directory tree recursively, and escapes quotes in the path', () => {
    expect(buildReferenceChunkSql("/Volumes/c/s/reference_docs/Epic/O'Brien.pdf", false)).toContain("read_files('/Volumes/c/s/reference_docs/Epic/O\\'Brien.pdf', format => 'binaryFile')");
    expect(buildReferenceChunkSql('/Volumes/c/s/reference_docs/', true)).toContain("recursiveFileLookup => 'true'");
  });

  it('drops page furniture and produces the chunk table columns', () => {
    const sql = buildReferenceChunkSql('/Volumes/c/s/reference_docs/', true);
    expect(sql).toContain("t NOT IN ('page_header', 'page_footer', 'page_number')");
    for (const col of ['chunk_id', 'source_system', 'file_path', 'file_name', 'chunk_index', 'page_start', 'page_end', 'heading', 'content', 'char_count', 'embed_text', 'file_modified', 'file_size', 'indexed_at']) {
      expect(sql).toContain(` AS ${col}`);
    }
  });
});
