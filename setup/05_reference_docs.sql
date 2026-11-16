-- Reference-document store for the Knowledge Assistant feature.
--
-- Users upload source-metadata reference PDFs (data dictionaries, field
-- definitions, ERDs, mapping runbooks) into this Unity Catalog volume via the
-- References page. An Agent Bricks Knowledge Assistant is pointed at the volume
-- (see setup/create_ka.sh) and the app queries it at mapping time to ground the
-- LLM's attribute discovery and JOIN-SQL generation.
--
-- Easiest: run `python setup/run_setup.py --catalog <your_catalog>`. To run by
-- hand instead, replace `your_catalog` below with your catalog name (and
-- `aimapper` with your schema if you changed it).
USE CATALOG your_catalog;
USE SCHEMA aimapper;

-- A managed UC volume; the app reads/writes files here on-behalf-of the user
-- via the Files API (needs the `files` OBO scope — see databricks.yml).
CREATE VOLUME IF NOT EXISTS reference_docs
COMMENT 'Reference PDFs describing source metadata, indexed by the AI Mapper Knowledge Assistant';
