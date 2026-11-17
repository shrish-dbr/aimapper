import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { VIEWER_WRITE_TABLES, EDITOR_WRITE_TABLES } from '../server/aimapper/permissions.js';

// setup/install.py grants the role groups the same table privileges the app's
// "Apply group permissions" does. The installer is Python, so check the lists match.
const py = readFileSync(new URL('../setup/install.py', import.meta.url), 'utf8');
const pyList = (name: string): string[] => {
  const m = py.match(new RegExp(`^${name} = (?:VIEWER_WRITE_TABLES \\+ )?\\[([\\s\\S]*?)\\]`, 'm'));
  if (!m) throw new Error(`${name} not found in install.py`);
  const own = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  return m[0].includes('VIEWER_WRITE_TABLES +') ? [...pyList('VIEWER_WRITE_TABLES'), ...own] : own;
};

describe('installer ↔ app permission plan', () => {
  it('grants the same write tables per role', () => {
    expect(pyList('VIEWER_WRITE_TABLES')).toEqual(VIEWER_WRITE_TABLES);
    expect(pyList('EDITOR_WRITE_TABLES')).toEqual(EDITOR_WRITE_TABLES);
  });

  it('creates every table the app writes', () => {
    const sql = ['01_create_tables.sql', '04_examples.sql', '06_retrieval_corpus.sql', '07_reference_chunks.sql']
      .map((f) => readFileSync(new URL(`../setup/${f}`, import.meta.url), 'utf8'))
      .join('\n');
    for (const t of EDITOR_WRITE_TABLES) expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`));
  });
});
