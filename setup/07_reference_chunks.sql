-- Reference-document grounding: the app parses PDFs in
-- the reference_docs volume with ai_parse_document, chunks them (server/aimapper/references.ts)
-- and writes them here; a Vector Search Delta Sync index embeds `embed_text`.
-- Create the index with setup/create_reference_index.sh after this table exists.
USE CATALOG your_catalog;
USE SCHEMA aimapper;

CREATE TABLE IF NOT EXISTS aimapper_reference_chunks (
  chunk_id      STRING NOT NULL COMMENT 'sha256(file_path|section|chunk) — primary key for the Vector Search index',
  source_system STRING COMMENT 'Source system (EHR) — the reference_docs/<folder> the file lives in; hard retrieval filter',
  file_path     STRING NOT NULL COMMENT 'Full /Volumes path of the reference document',
  file_name     STRING COMMENT 'File name (for citations)',
  chunk_index   INT    COMMENT '0-based position of the chunk within the file',
  page_start    INT    COMMENT 'First page (1-based) the chunk covers',
  page_end      INT    COMMENT 'Last page (1-based) the chunk covers',
  heading       STRING COMMENT 'Nearest section heading',
  content       STRING COMMENT 'Chunk text passed to the LLM (tables flattened to "a | b" rows)',
  char_count    INT    COMMENT 'length(content)',
  embed_text    STRING COMMENT 'Text embedded by Vector Search: document + source system + heading + content',
  file_modified TIMESTAMP COMMENT 'Source file modification time at indexing (change detection)',
  file_size     BIGINT COMMENT 'Source file size at indexing (change detection)',
  indexed_at    TIMESTAMP COMMENT 'When this chunk was produced'
) USING DELTA
COMMENT 'Reference documents parsed with ai_parse_document and chunked for Vector Search grounding'
TBLPROPERTIES (delta.enableChangeDataFeed = true);
