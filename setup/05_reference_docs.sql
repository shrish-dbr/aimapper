-- Reference-document store for doc-grounded mapping.
--
-- Users upload source-metadata reference PDFs (data dictionaries, field
-- definitions, ERDs, mapping runbooks) into this Unity Catalog volume via the
-- References page. The app parses them into passages (aimapper_reference_chunks,
-- setup/07_reference_chunks.sql) indexed with Vector Search, and retrieves the most
-- relevant passages at mapping time to ground attribute discovery and JOIN-SQL
-- generation.
--
-- Normally run by the installer (python3 setup/install.py install). To run by
-- hand instead, replace `your_catalog` below with your catalog name (and
-- `aimapper` with your schema if you changed it).
USE CATALOG your_catalog;
USE SCHEMA aimapper;

-- A managed UC volume; the app reads/writes files here on-behalf-of the user
-- via the Files API (needs the `files` OBO scope — see databricks.yml).
CREATE VOLUME IF NOT EXISTS reference_docs
COMMENT 'Reference PDFs describing source metadata, parsed and indexed by AI Mapper for Vector Search grounding';
