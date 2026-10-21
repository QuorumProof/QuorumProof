/**
 * Tests for the schema diagram generator (Issue #1678).
 *
 * The parser tests use inline SQL so they pin behaviour independent of the
 * real migrations. The drift test checks that the committed
 * docs/database-schema.md matches what the generator produces from the
 * migrations on disk, so schema changes that skip regeneration fail CI.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildSchemaModel,
  renderMermaid,
  renderSchemaDoc,
  generateSchemaDoc,
  SCHEMA_DOC_PATH,
} from '../scripts/generate-schema-diagram.js';

const PARENT_SQL = `
-- a comment that should be ignored
CREATE TABLE IF NOT EXISTS requests (
  id          TEXT PRIMARY KEY,           /* inline block comment */
  owner       TEXT NOT NULL,
  amount      NUMERIC(10, 2) DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const CHILD_SQL = `
CREATE TABLE IF NOT EXISTS otps (
  request_id  TEXT PRIMARY KEY REFERENCES requests (id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  CONSTRAINT otps_code_check CHECK (length(code) = 6)
);
CREATE TABLE IF NOT EXISTS ledger (
  id          SERIAL PRIMARY KEY,
  request_id  TEXT,
  owner       TEXT,
  UNIQUE (request_id, owner),
  FOREIGN KEY (request_id) REFERENCES requests (id)
);
`;

describe('parsing CREATE TABLE', () => {
  const model = buildSchemaModel([
    { name: '0001_parent.up.sql', sql: PARENT_SQL },
    { name: '0002_child.up.sql', sql: CHILD_SQL },
  ]);
  const byName = Object.fromEntries(model.tables.map(t => [t.name, t]));

  it('finds every table and sorts them by name', () => {
    expect(model.tables.map(t => t.name)).toEqual(['ledger', 'otps', 'requests']);
  });

  it('records columns, types, primary key and not-null flags', () => {
    const id = byName.requests.columns.find(c => c.name === 'id')!;
    expect(id).toMatchObject({ type: 'TEXT', primaryKey: true });
    const owner = byName.requests.columns.find(c => c.name === 'owner')!;
    expect(owner).toMatchObject({ type: 'TEXT', notNull: true, primaryKey: false });
  });

  it('sanitizes parameterised types so Mermaid can render them', () => {
    const amount = byName.requests.columns.find(c => c.name === 'amount')!;
    expect(amount.type).toBe('NUMERIC_10_2');
  });

  it('ignores CHECK and CONSTRAINT clauses as columns', () => {
    expect(byName.otps.columns.map(c => c.name)).toEqual(['request_id', 'code']);
  });

  it('applies table-level UNIQUE and PRIMARY KEY clauses to their columns', () => {
    const request = byName.ledger.columns.find(c => c.name === 'request_id')!;
    expect(request.unique).toBe(true);
    expect(byName.ledger.columns.find(c => c.name === 'id')!.primaryKey).toBe(true);
  });

  it('captures inline and table-level foreign keys', () => {
    expect(byName.otps.foreignKeys).toEqual([{ column: 'request_id', table: 'requests', refColumn: 'id' }]);
    expect(byName.ledger.foreignKeys).toEqual([{ column: 'request_id', table: 'requests', refColumn: 'id' }]);
  });
});

describe('ALTER TABLE ADD COLUMN', () => {
  it('adds the column to a known table and its reference', () => {
    const model = buildSchemaModel([
      { name: '0001.up.sql', sql: PARENT_SQL },
      {
        name: '0002.up.sql',
        sql: 'ALTER TABLE IF EXISTS requests ADD COLUMN IF NOT EXISTS parent TEXT REFERENCES requests (id);',
      },
    ]);
    const requests = model.tables.find(t => t.name === 'requests')!;
    expect(requests.columns.map(c => c.name)).toContain('parent');
    expect(requests.foreignKeys).toContainEqual({ column: 'parent', table: 'requests', refColumn: 'id' });
  });

  it('reports ALTERs on tables no migration creates', () => {
    const model = buildSchemaModel([
      { name: '0001.up.sql', sql: 'ALTER TABLE missing ADD COLUMN x TEXT;' },
    ]);
    expect(model.notes.join('\n')).toMatch(/alters `missing`, which no migration creates/);
  });
});

describe('conflicting definitions', () => {
  it('keeps the first definition and reports the conflict', () => {
    const model = buildSchemaModel([
      { name: '0007_a.up.sql', sql: 'CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY);' },
      { name: '0007_b.up.sql', sql: 'CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, extra TEXT);' },
    ]);
    const t = model.tables.find(x => x.name === 't')!;
    expect(t.columns.map(c => c.name)).toEqual(['id']);
    expect(t.source).toBe('0007_a.up.sql');
    expect(model.notes[0]).toMatch(/`t` is defined in `0007_a.up.sql` and again in `0007_b.up.sql`/);
  });

  it('does not report an identical redefinition', () => {
    const sql = 'CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY);';
    const model = buildSchemaModel([
      { name: 'a.up.sql', sql },
      { name: 'b.up.sql', sql },
    ]);
    expect(model.notes).toEqual([]);
  });

  it('notes foreign keys that point at tables no migration creates', () => {
    const model = buildSchemaModel([
      { name: 'a.up.sql', sql: 'CREATE TABLE c (id TEXT PRIMARY KEY, p TEXT REFERENCES nowhere (id));' },
    ]);
    expect(model.notes.join('\n')).toMatch(/`c.p` references `nowhere`/);
  });
});

describe('rendering', () => {
  const model = buildSchemaModel([
    { name: '0001_parent.up.sql', sql: PARENT_SQL },
    { name: '0002_child.up.sql', sql: CHILD_SQL },
  ]);

  it('emits an erDiagram with one relationship per resolvable foreign key', () => {
    const mermaid = renderMermaid(model);
    expect(mermaid.startsWith('erDiagram')).toBe(true);
    expect(mermaid).toContain('requests ||--o{ otps : "request_id"');
    expect(mermaid).toContain('requests ||--o{ ledger : "request_id"');
    expect(mermaid).toContain('TEXT id PK');
  });

  it('is deterministic for the same input', () => {
    expect(renderSchemaDoc(model)).toBe(renderSchemaDoc(buildSchemaModel([
      { name: '0001_parent.up.sql', sql: PARENT_SQL },
      { name: '0002_child.up.sql', sql: CHILD_SQL },
    ])));
  });
});

describe('committed schema diagram', () => {
  it('matches the migrations on disk (regenerate with: npm run schema:diagram)', () => {
    const { markdown } = generateSchemaDoc();
    const committed = readFileSync(SCHEMA_DOC_PATH, 'utf8');
    expect(committed).toBe(markdown);
  });

  it('includes every table defined in the migrations', () => {
    const { model } = generateSchemaDoc();
    const committed = readFileSync(SCHEMA_DOC_PATH, 'utf8');
    for (const table of model.tables) {
      expect(committed).toContain(`\`${table.name}\``);
    }
    expect(model.tables.length).toBeGreaterThan(0);
  });
});
