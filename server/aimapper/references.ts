// Reference-document grounding via Vector Search.
//
// Pipeline: PDFs in the reference_docs volume → ai_parse_document → chunked in SQL
// (buildReferenceChunkSql) → aimapper_reference_chunks (CDF) → Delta Sync index.
// At mapping time the app queries the index per column group (buildReferenceQueries),
// hard-filtered to the project's source system, and packs WHOLE chunks best-first into
// the Prompt Sizing budget (packReferenceChunks). Pure functions — unit-tested.

/** Target characters per chunk; long elements are split into ~ELEMENT_PIECE pieces. */
export const CHUNK_TARGET_CHARS = 1500;
export const ELEMENT_PIECE_CHARS = 1200;
/** Chunks shorter than this (e.g. a lone section title) are dropped. */
export const MIN_CHUNK_CHARS = 40;
/** Target columns per retrieval query, so wide targets get passages for every column. */
export const COLUMNS_PER_QUERY = 15;
/** Max retrieval queries per mapping (bounds latency on very wide targets). */
export const MAX_REFERENCE_QUERIES = 6;

const sqlStr = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * SELECT producing chunk rows (columns match aimapper_reference_chunks) for one file
 * or a whole directory tree. Everything heavy runs in the warehouse:
 *  - drop page headers/footers/numbers; flatten HTML tables to "a | b" rows
 *  - a new section starts at every section_header/title; its text is carried as heading
 *  - elements longer than ~1.2k chars are split by line; table continuations repeat
 *    the table's header row so each piece stands alone
 *  - pieces are packed into ~1.5k-char chunks that never cross a section boundary
 */
export function buildReferenceChunkSql(path: string, recursive: boolean): string {
  const src = recursive
    ? `read_files(${sqlStr(path)}, format => 'binaryFile', recursiveFileLookup => 'true')`
    : `read_files(${sqlStr(path)}, format => 'binaryFile')`;
  const ss = `regexp_extract(file_path, '/reference_docs/([^/]+)/', 1)`;
  const fname = `regexp_extract(file_path, '[^/]+$', 0)`;
  return `SELECT * FROM (
WITH files AS (
  SELECT regexp_replace(path, '^dbfs:', '') AS file_path, modificationTime AS file_modified, length AS file_size, content
  FROM ${src}
),
parsed AS (
  SELECT file_path, file_modified, file_size, ai_parse_document(content, map('version', '2.0')) AS doc FROM files
),
els AS (
  SELECT file_path, file_modified, file_size, el_pos,
         variant_get(el, '$.type', 'STRING') AS t,
         coalesce(variant_get(el, '$.bbox[0].page_id', 'INT'), 0) + 1 AS page,
         variant_get(el, '$.content', 'STRING') AS raw
  FROM parsed LATERAL VIEW posexplode(variant_get(doc, '$.document.elements', 'ARRAY<VARIANT>')) e AS el_pos, el
),
norm AS (
  SELECT *,
    trim(CASE WHEN t = 'table' THEN
      regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
        raw, '</t[dh]>\\\\s*', ' | '), '</tr>', '\\n'), '<[^>]+>', ''), '[ \\\\t]*\\\\|[ \\\\t]*(\\\\n|$)', '\\n'),
        '&amp;', '&'), '&lt;', '<'), '&gt;', '>'), '\\\\n{2,}', '\\n')
    ELSE raw END) AS txt,
    sum(CASE WHEN t IN ('section_header', 'title') THEN 1 ELSE 0 END)
      OVER (PARTITION BY file_path ORDER BY el_pos ROWS UNBOUNDED PRECEDING) AS sec
  FROM els
  WHERE t NOT IN ('page_header', 'page_footer', 'page_number') AND raw IS NOT NULL AND trim(raw) <> ''
),
headed AS (
  SELECT *, first_value(CASE WHEN t IN ('section_header', 'title') THEN txt END, true)
              OVER (PARTITION BY file_path, sec ORDER BY el_pos ROWS UNBOUNDED PRECEDING) AS heading
  FROM norm
),
lines AS (
  SELECT h.*, l.line_pos, l.line, element_at(split(h.txt, '\\n'), 1) AS first_line,
         sum(length(l.line) + 1) OVER (PARTITION BY h.file_path, h.el_pos ORDER BY l.line_pos ROWS UNBOUNDED PRECEDING) AS el_cum
  FROM headed h LATERAL VIEW posexplode(split(h.txt, '\\n')) l AS line_pos, line
),
pieces AS (
  SELECT file_path, file_modified, file_size, sec, heading, el_pos, t, floor((el_cum - 1) / ${ELEMENT_PIECE_CHARS}) AS piece,
         min(page) AS page_start, max(page) AS page_end, first(first_line) AS first_line,
         array_join(transform(array_sort(collect_list(struct(line_pos, line))), x -> x.line), '\\n') AS piece_text
  FROM lines GROUP BY file_path, file_modified, file_size, sec, heading, el_pos, t, floor((el_cum - 1) / ${ELEMENT_PIECE_CHARS})
),
pieces2 AS (
  SELECT *, CASE WHEN t = 'table' AND piece > 0 THEN concat(first_line, '\\n', piece_text) ELSE piece_text END AS ptext
  FROM pieces
),
packed AS (
  SELECT *, floor((sum(length(ptext) + 2) OVER (PARTITION BY file_path, sec ORDER BY el_pos, piece ROWS UNBOUNDED PRECEDING) - length(ptext) - 2) / ${CHUNK_TARGET_CHARS}) AS chunk_in_sec
  FROM pieces2
),
chunks AS (
  SELECT file_path, file_modified, file_size, sec, chunk_in_sec, first(heading) AS heading,
         min(page_start) AS page_start, max(page_end) AS page_end,
         array_join(transform(array_sort(collect_list(struct(el_pos, piece, ptext))), x -> x.ptext), '\\n\\n') AS content
  FROM packed GROUP BY file_path, file_modified, file_size, sec, chunk_in_sec
)
SELECT sha2(concat(file_path, '|', sec, '|', chunk_in_sec), 256) AS chunk_id,
       ${ss} AS source_system,
       file_path, ${fname} AS file_name,
       CAST(row_number() OVER (PARTITION BY file_path ORDER BY sec, chunk_in_sec) - 1 AS INT) AS chunk_index,
       CAST(page_start AS INT) AS page_start, CAST(page_end AS INT) AS page_end, heading, content,
       CAST(length(content) AS INT) AS char_count,
       substr(concat('Document: ', ${fname}, '\\nSource system: ', coalesce(${ss}, ''),
              CASE WHEN heading IS NOT NULL THEN concat('\\nSection: ', heading) ELSE '' END, '\\n\\n', content), 1, 6000) AS embed_text,
       file_modified, file_size, current_timestamp() AS indexed_at
FROM chunks
) WHERE char_count >= ${MIN_CHUNK_CHARS}`;
}

/**
 * Retrieval query texts for a mapping. Wide targets are split into column groups so
 * every group of target columns gets its own nearest passages (one query for all 60
 * columns would only surface passages about a few of them).
 */
export function buildReferenceQueries(targetTable: string, targetColumns: string[], sourceColumns: string[]): string[] {
  const src = sourceColumns.filter(Boolean).slice(0, 40).join(', ');
  const cols = targetColumns.filter(Boolean);
  const groups: string[][] = [];
  for (let i = 0; i < cols.length && groups.length < MAX_REFERENCE_QUERIES; i += COLUMNS_PER_QUERY) {
    groups.push(cols.slice(i, i + COLUMNS_PER_QUERY));
  }
  if (groups.length === 0) groups.push([]);
  return groups.map(
    (g) =>
      `Field definitions, value codings and transformation rules for mapping source data to the "${targetTable}" target` +
      (g.length ? `. Target columns: ${g.join(', ')}` : '') +
      (src ? `. Source columns: ${src}` : ''),
  );
}

export interface ReferenceChunk {
  chunk_id: string;
  file_name: string;
  page_start: number | null;
  page_end: number | null;
  heading: string | null;
  content: string;
  score: number;
}

export interface ReferenceSource {
  file: string;
  pages: string;
  heading: string | null;
  score: number;
  chars: number;
}

/** "[Epic_PATIENT.pdf p.3–4 · Column Information]" */
export function chunkLabel(c: Pick<ReferenceChunk, 'file_name' | 'page_start' | 'page_end' | 'heading'>): string {
  const pages =
    c.page_start == null ? '' : c.page_end != null && c.page_end !== c.page_start ? ` p.${c.page_start}–${c.page_end}` : ` p.${c.page_start}`;
  return `[${c.file_name}${pages}${c.heading ? ` · ${c.heading}` : ''}]`;
}

/**
 * Merge results from several queries (keep each chunk's best score), then add WHOLE
 * chunks best-first until the character budget is full. A chunk that doesn't fit is
 * skipped (a smaller, lower-ranked one may still fit) — chunks are never cut.
 */
export function packReferenceChunks(
  results: ReferenceChunk[][],
  budgetChars: number,
): { text: string; sources: ReferenceSource[]; candidates: number } {
  const best = new Map<string, ReferenceChunk>();
  for (const list of results) {
    for (const c of list) {
      const prev = best.get(c.chunk_id);
      if (!prev || c.score > prev.score) best.set(c.chunk_id, c);
    }
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score);
  const parts: string[] = [];
  const sources: ReferenceSource[] = [];
  let used = 0;
  for (const c of ranked) {
    const block = `${chunkLabel(c)}\n${c.content.trim()}`;
    const cost = block.length + (parts.length ? 2 : 0);
    if (used + cost > budgetChars) continue;
    parts.push(block);
    used += cost;
    sources.push({
      file: c.file_name,
      pages: c.page_start == null ? '' : c.page_end != null && c.page_end !== c.page_start ? `${c.page_start}–${c.page_end}` : String(c.page_start),
      heading: c.heading,
      score: Math.round(c.score * 1000) / 1000,
      chars: c.content.length,
    });
  }
  return { text: parts.join('\n\n'), sources, candidates: ranked.length };
}
