/**
 * Generate the database schema diagram from the migrations (Issue #1678).
 *
 * Parses `migrations/*.up.sql` in apply order and writes
 * `docs/database-schema.md`, which contains a Mermaid `erDiagram`, a table
 * index, the foreign-key relationships, and a list of migration conflicts.
 *
 * Usage (from api-server/):
 *   npm run schema:diagram          # regenerate docs/database-schema.md
 *   npm run schema:diagram:check    # exit 1 if the committed doc is stale
 *
 * Conflict handling mirrors what Postgres does when the runner applies the
 * files in order: the first `CREATE TABLE` for a name wins, and later
 * definitions of the same name are ignored (and reported). This means the
 * diagram shows the schema that actually exists in a database, not what each
 * file says in isolation.
 *
 * The parser handles the subset of SQL these migrations use: `CREATE TABLE`
 * with column constraints or table-level `PRIMARY KEY`/`UNIQUE`/`FOREIGN KEY`
 * clauses, and `ALTER TABLE ... ADD COLUMN`. Functions, triggers and indexes
 * are ignored, since they do not change the entity shape.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface ForeignKey {
  column: string;
  table: string;
  refColumn: string;
}

export interface Column {
  name: string;
  type: string;
  primaryKey: boolean;
  unique: boolean;
  notNull: boolean;
}

export interface Table {
  name: string;
  /** Migration file that first defined the table. */
  source: string;
  columns: Column[];
  foreignKeys: ForeignKey[];
}

export interface MigrationFile {
  name: string;
  sql: string;
}

export interface SchemaModel {
  tables: Table[];
  /** Human-readable notes about conflicts and unresolved references. */
  notes: string[];
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';

/** Remove `/* ... *\/` and `-- ...` comments. */
export function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

/** Index of the `)` matching the `(` at `openIndex`, or -1 if unbalanced. */
function matchingParen(sql: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a table body on commas that are not inside parentheses. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Column names listed inside a `(a, b)` clause. */
function identifierList(text: string): string[] {
  return text
    .split(',')
    .map(s => s.trim().replace(/\s+(ASC|DESC)$/i, '').split(/\s+/)[0])
    .filter(Boolean);
}

/** Make a SQL type safe for a Mermaid attribute (e.g. `VARCHAR(255)` -> `VARCHAR_255`). */
function sanitizeType(type: string): string {
  return type.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'TEXT';
}

/** Parse one column definition such as `id BIGSERIAL PRIMARY KEY`. */
export function parseColumn(def: string): { column: Column; references?: ForeignKey } | null {
  const nameMatch = new RegExp(`^(${IDENT})\\s+(.*)$`, 'is').exec(def);
  if (!nameMatch) return null;
  const [, name, rest] = nameMatch;
  const typeMatch = new RegExp(`^(${IDENT}(?:\\s*\\([^)]*\\))?(?:\\s*\\[\\])?)`, 'i').exec(rest);
  const type = sanitizeType(typeMatch ? typeMatch[1] : 'UNKNOWN');
  const column: Column = {
    name,
    type,
    primaryKey: /\bPRIMARY\s+KEY\b/i.test(rest),
    unique: /\bUNIQUE\b/i.test(rest),
    notNull: /\bNOT\s+NULL\b/i.test(rest),
  };
  const ref = new RegExp(`\\bREFERENCES\\s+(${IDENT})\\s*\\(\\s*(${IDENT})\\s*\\)`, 'i').exec(rest);
  return {
    column,
    references: ref ? { column: name, table: ref[1], refColumn: ref[2] } : undefined,
  };
}

/** Parse every `CREATE TABLE` in one file, in order. */
function parseCreateTables(sql: string, source: string): Table[] {
  const tables: Table[] = [];
  const re = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s*\\(`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const open = match.index + match[0].length - 1;
    const close = matchingParen(sql, open);
    if (close < 0) continue;
    const table: Table = { name: match[1], source, columns: [], foreignKeys: [] };
    const tablePrimaryKeys: string[] = [];
    const tableUniques: string[] = [];

    for (const raw of splitTopLevel(sql.slice(open + 1, close))) {
      const item = raw.replace(/^CONSTRAINT\s+\S+\s+/i, '');
      const fk = new RegExp(`^FOREIGN\\s+KEY\\s*\\(([^)]*)\\)\\s*REFERENCES\\s+(${IDENT})\\s*\\(([^)]*)\\)`, 'i').exec(item);
      if (fk) {
        const cols = identifierList(fk[1]);
        const refCols = identifierList(fk[3]);
        cols.forEach((column, i) =>
          table.foreignKeys.push({ column, table: fk[2], refColumn: refCols[i] ?? refCols[0] }),
        );
        continue;
      }
      const pk = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(item);
      if (pk) {
        tablePrimaryKeys.push(...identifierList(pk[1]));
        continue;
      }
      const uq = /^UNIQUE\s*\(([^)]*)\)/i.exec(item);
      if (uq) {
        tableUniques.push(...identifierList(uq[1]));
        continue;
      }
      if (/^(CHECK|EXCLUDE|INDEX|KEY)\b/i.test(item)) continue;

      const parsed = parseColumn(item);
      if (!parsed) continue;
      table.columns.push(parsed.column);
      if (parsed.references) table.foreignKeys.push(parsed.references);
    }

    for (const col of table.columns) {
      if (tablePrimaryKeys.includes(col.name)) col.primaryKey = true;
      if (tableUniques.includes(col.name)) col.unique = true;
    }
    tables.push(table);
  }
  return tables;
}

/**
 * Build the schema model from migration files.
 * Files are applied in the order given, so callers must sort them first.
 */
export function buildSchemaModel(files: MigrationFile[]): SchemaModel {
  const byName = new Map<string, Table>();
  const notes: string[] = [];

  for (const file of files) {
    const sql = stripComments(file.sql);

    for (const table of parseCreateTables(sql, file.name)) {
      const existing = byName.get(table.name);
      if (!existing) {
        byName.set(table.name, table);
        continue;
      }
      if (!sameShape(existing, table)) {
        const where = existing.source === file.name
          ? `twice in \`${file.name}\``
          : `in \`${existing.source}\` and again in \`${file.name}\``;
        notes.push(
          `\`${table.name}\` is defined ${where} with a different shape; the second definition is ignored.`,
        );
      }
    }

    const alterRe = new RegExp(
      `ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})\\s+ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?([^;]+);`,
      'gi',
    );
    let alter: RegExpExecArray | null;
    while ((alter = alterRe.exec(sql)) !== null) {
      const [, tableName, def] = alter;
      const table = byName.get(tableName);
      const parsed = parseColumn(def.trim());
      if (!table) {
        notes.push(`\`${file.name}\` alters \`${tableName}\`, which no migration creates; the change is not shown.`);
        continue;
      }
      if (!parsed) continue;
      if (!table.columns.some(c => c.name === parsed.column.name)) table.columns.push(parsed.column);
      if (parsed.references) table.foreignKeys.push(parsed.references);
    }
  }

  const tables = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const table of tables) {
    for (const fk of table.foreignKeys) {
      if (!byName.has(fk.table)) {
        notes.push(`\`${table.name}.${fk.column}\` references \`${fk.table}\`, which no migration creates.`);
      }
    }
  }
  return { tables, notes: [...new Set(notes)] };
}

function sameShape(a: Table, b: Table): boolean {
  const key = (t: Table) =>
    t.columns.map(c => `${c.name}:${c.type}:${c.primaryKey}:${c.unique}:${c.notNull}`).join('|');
  return key(a) === key(b);
}

/** Render the Mermaid `erDiagram` block. Deterministic for a given model. */
export function renderMermaid(model: SchemaModel): string {
  const lines = ['erDiagram'];
  for (const table of model.tables) {
    lines.push(`    ${table.name} {`);
    for (const col of table.columns) {
      const keys = [col.primaryKey && 'PK', col.unique && !col.primaryKey && 'UK'].filter(Boolean);
      const suffix = keys.length ? ` ${keys.join(', ')}` : '';
      lines.push(`        ${sanitizeType(col.type)} ${col.name}${suffix}`);
    }
    lines.push('    }');
  }
  const names = new Set(model.tables.map(t => t.name));
  for (const table of model.tables) {
    for (const fk of table.foreignKeys) {
      if (!names.has(fk.table)) continue;
      lines.push(`    ${fk.table} ||--o{ ${table.name} : "${fk.column}"`);
    }
  }
  return lines.join('\n');
}

/** Render the full `docs/database-schema.md` contents. */
export function renderSchemaDoc(model: SchemaModel): string {
  const rows = model.tables.map(t => {
    const fks = t.foreignKeys.length;
    return `| \`${t.name}\` | ${t.columns.length} | ${fks} | \`${t.source}\` |`;
  });
  const relationships = model.tables.flatMap(t =>
    t.foreignKeys
      .filter(fk => model.tables.some(p => p.name === fk.table))
      .map(fk => `| \`${fk.table}\` | \`${t.name}\` | \`${fk.column}\` | \`${fk.refColumn}\` |`),
  );
  const notes = model.notes.length
    ? model.notes.map(n => `- ${n}`).join('\n')
    : '- None.';

  return `# Database Schema

<!-- GENERATED FILE. Do not edit by hand.
     Regenerate with: cd api-server && npm run schema:diagram
     CI verifies this file is current: npm run schema:diagram:check -->

This diagram is generated from the API server migrations in
[\`api-server/migrations/\`](../api-server/migrations/README.md), applied in
filename order (issue #1678). It shows the schema a database has after all
\`*.up.sql\` files run. Keys: \`PK\` primary key, \`UK\` unique. Each edge runs
from a referenced table to the table holding the foreign key.

\`\`\`mermaid
${renderMermaid(model)}
\`\`\`

## Tables

| Table | Columns | Foreign keys | Defined in |
|---|---|---|---|
${rows.join('\n')}

## Relationships

| Referenced table | Referencing table | Column | References column |
|---|---|---|---|
${relationships.length ? relationships.join('\n') : '| — | — | — | — |'}

## Migration notes

${notes}

Migration notes list conflicts and unresolved references the parser found.
They do not fail the build, but they are worth fixing in a new migration.
`;
}

/** Read the up-migrations in filename order. */
export function readMigrations(migrationsDir: string): MigrationFile[] {
  return readdirSync(migrationsDir)
    .filter(f => f.endsWith('.up.sql'))
    .sort()
    .map(name => ({ name, sql: readFileSync(join(migrationsDir, name), 'utf8') }));
}

const API_SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATIONS_DIR = join(API_SERVER_DIR, 'migrations');
export const SCHEMA_DOC_PATH = join(API_SERVER_DIR, '..', 'docs', 'database-schema.md');

/** Generate the current schema document from the migrations on disk. */
export function generateSchemaDoc(migrationsDir = MIGRATIONS_DIR): { model: SchemaModel; markdown: string } {
  const model = buildSchemaModel(readMigrations(migrationsDir));
  return { model, markdown: renderSchemaDoc(model) };
}

function main(argv: string[]): number {
  const check = argv.includes('--check');
  const { model, markdown } = generateSchemaDoc();

  if (check) {
    const committed = existsSync(SCHEMA_DOC_PATH) ? readFileSync(SCHEMA_DOC_PATH, 'utf8') : '';
    if (committed !== markdown) {
      console.error(`${SCHEMA_DOC_PATH} is out of date. Run: npm run schema:diagram`);
      return 1;
    }
    console.log(`Schema diagram is current (${model.tables.length} tables).`);
    return 0;
  }

  writeFileSync(SCHEMA_DOC_PATH, markdown);
  console.log(`Wrote ${SCHEMA_DOC_PATH} (${model.tables.length} tables, ${model.notes.length} notes).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
