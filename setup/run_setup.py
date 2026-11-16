#!/usr/bin/env python3
"""Run the AI Mapper setup SQL against a SQL Warehouse, substituting your
catalog/schema in — so you never hand-edit the .sql files.

Reads the SAME settings the app uses, so one configuration covers both:
  AIMAPPER_CATALOG      target catalog (required)     --catalog
  AIMAPPER_SCHEMA       target schema (default: aimapper)  --schema
  DATABRICKS_WAREHOUSE_ID SQL Warehouse id (required)   --warehouse-id
Auth uses your Databricks CLI config (DATABRICKS_CONFIG_PROFILE / --profile).

Usage:
  export DATABRICKS_CONFIG_PROFILE=your_profile
  python setup/run_setup.py --catalog my_catalog --warehouse-id 0123456789abcdef

The .sql files are authored with the placeholders `your_catalog` (catalog) and
`aimapper` (schema). This script rewrites both to your values before running,
so the files stay hand-runnable in the SQL editor too.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.sql import StatementState

SQL_FILES = ["01_create_tables.sql", "02_seed_target_schema.sql",
             "03_sample_source.sql", "04_examples.sql",
             "05_reference_docs.sql", "06_retrieval_corpus.sql", "07_reference_chunks.sql"]


def substitute(sql: str, catalog: str, schema: str) -> str:
    """Rewrite the placeholder catalog/schema to the real values. Ordered so the
    qualified `your_catalog.aimapper` form is handled before the bare tokens."""
    sql = sql.replace("your_catalog.aimapper", f"{catalog}.{schema}")
    sql = re.sub(r"\bUSE\s+CATALOG\s+your_catalog\b", f"USE CATALOG {catalog}", sql)
    sql = re.sub(r"\bUSE\s+SCHEMA\s+aimapper\b", f"USE SCHEMA {schema}", sql)
    return sql.replace("your_catalog", catalog)


def split_statements(sql: str) -> list[str]:
    """Strip `--` line comments and split into statements on `;`, ignoring any
    `;` that appears inside a single-quoted string literal (the seed data has
    semicolons in column comments, e.g. 'Strip dashes/spaces; keep 9 digits')."""
    no_comments = "\n".join(
        line for line in sql.splitlines() if not line.lstrip().startswith("--")
    )
    statements, buf, in_str = [], [], False
    i, n = 0, len(no_comments)
    while i < n:
        ch = no_comments[i]
        if ch == "'":
            # '' inside a string is an escaped quote, not a terminator.
            if in_str and i + 1 < n and no_comments[i + 1] == "'":
                buf.append("''")
                i += 2
                continue
            in_str = not in_str
            buf.append(ch)
        elif ch == ";" and not in_str:
            stmt = "".join(buf).strip()
            if stmt:
                statements.append(stmt)
            buf = []
        else:
            buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        statements.append(tail)
    return statements


def main() -> int:
    p = argparse.ArgumentParser(description="Run AI Mapper setup SQL.")
    p.add_argument("--catalog", default=os.environ.get("AIMAPPER_CATALOG"))
    p.add_argument("--schema", default=os.environ.get("AIMAPPER_SCHEMA", "aimapper"))
    p.add_argument("--warehouse-id", default=os.environ.get("DATABRICKS_WAREHOUSE_ID"))
    p.add_argument("--profile", default=os.environ.get("DATABRICKS_CONFIG_PROFILE"))
    args = p.parse_args()

    missing = [n for n, v in (("catalog", args.catalog), ("warehouse-id", args.warehouse_id)) if not v]
    if missing:
        print(f"error: missing required value(s): {', '.join(missing)}\n"
              f"       pass --{missing[0]} or set the matching env var.", file=sys.stderr)
        return 2

    w = WorkspaceClient(profile=args.profile) if args.profile else WorkspaceClient()
    here = Path(__file__).parent

    for fname in SQL_FILES:
        path = here / fname
        if not path.exists():
            print(f"skip {fname} (not found)")
            continue
        sql = substitute(path.read_text(), args.catalog, args.schema)
        # Each statement runs in its own session, so `USE CATALOG/SCHEMA` would
        # not carry over. Drop those and instead set the session catalog/schema
        # per call via the SDK params, so unqualified table names resolve. The
        # CREATE CATALOG/SCHEMA statements are already fully qualified, so they
        # run with no context (the catalog/schema may not exist yet).
        statements = [s for s in split_statements(sql)
                      if not re.match(r"(?i)\s*USE\s+(CATALOG|SCHEMA)\b", s)]
        print(f"\n== {fname}: {len(statements)} statement(s) → "
              f"{args.catalog}.{args.schema} ==")
        for i, stmt in enumerate(statements, 1):
            creates_namespace = re.match(r"(?i)\s*CREATE\s+(CATALOG|SCHEMA)\b", stmt)
            ctx = {} if creates_namespace else {"catalog": args.catalog, "schema": args.schema}
            resp = w.statement_execution.execute_statement(
                warehouse_id=args.warehouse_id, statement=stmt, wait_timeout="50s", **ctx)
            state = resp.status.state if resp.status else None
            if state != StatementState.SUCCEEDED:
                err = resp.status.error.message if resp.status and resp.status.error else state
                # Creating the catalog/schema needs metastore privileges most
                # users lack, and it usually already exists — warn but continue.
                if creates_namespace:
                    print(f"  [{i}/{len(statements)}] skipped ({err}); "
                          f"assuming it already exists")
                    continue
                print(f"  [{i}/{len(statements)}] FAILED: {err}", file=sys.stderr)
                print(f"  statement was:\n{stmt[:300]}", file=sys.stderr)
                return 1
            print(f"  [{i}/{len(statements)}] ok")

    print("\nSetup complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
