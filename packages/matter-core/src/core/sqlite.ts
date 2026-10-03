/**
 * The SQLite projector: turn a classified folder into a typed table.
 *
 * `matter.sqlite` sits next to `matter.json` as a derived, disposable, READ-ONLY
 * mirror so a coding agent (or an in-app SQL console) can run arbitrary SQL over the
 * typed folder. The live in-app grid stays reactive JS over the projection; this is
 * the external read surface, not the app's query engine.
 *
 * This module is the PURE half: given the contract and the classified rows, it produces
 * the schema script (`DROP` + `CREATE`) and the row tuples to insert. The impure half
 * (writing the file) is a thin Tauri command that runs the script and parameter-binds
 * the rows; keeping serialization here makes it unit-testable with no filesystem.
 *
 * Three properties define the table:
 *   - Every READABLE row, valid or not. A folder of drafts is mostly incomplete, and
 *     the whole point of the WHERE filter (and of an agent triaging the folder) is to
 *     find those drafts ("my carousel posts that still need a publishDate"), so a row
 *     is included whether or not every field is filled. Only unparseable FILES are
 *     absent, they never became a row; their broken text stays in the markdown.
 *   - Field columns are nullable. A missing cell (MISSING_REQUIRED or
 *     MISSING_OPTIONAL) binds NULL; an out-of-domain value (INVALID) binds its raw
 *     value, which SQLite's flexible typing stores regardless of the column's declared
 *     affinity. So a draft is still filterable on the fields it does have.
 *   - No CHECK. Validation lives once, at classify time (the grid shows conformance
 *     per cell, amber for missing required, red for out-of-domain); the mirror just
 *     mirrors, so a SQL CHECK would only reject the very drafts the filter exists to
 *     surface.
 *
 * Two more columns sit beside the typed fields: `_extra` (the untyped frontmatter keys, as JSON) and
 * `body` (the row's markdown prose). When the contract is searchable, the script also emits an FTS5
 * virtual table over the searchable columns plus the trigger that the INSERT loop fires, so prose and
 * text fields are full-text queryable.
 */

import { type Field, storageOf } from '../field/index.js';
import type { RowConformance } from './conformance';
import type { Contract } from './contract';
import { stemOf } from './parse';

/** A SQLite-bindable scalar. Missing cells bind NULL, so values are nullable. */
export type SqlValue = string | number | null;

/**
 * The pure artifacts a Tauri command needs to materialize the table: exactly its
 * arguments, nothing exposed that the command does not consume. All SQL TEXT is built
 * here (one quoting implementation); the command runs the script and binds the rows,
 * so it never constructs SQL.
 */
export type SqliteProjection = {
	/** `DROP TABLE IF EXISTS ...; CREATE TABLE ...`: one param-less script for `execute_batch`. */
	schema: string;
	/** `INSERT INTO ... VALUES (?, ?, ...)`: one `?` placeholder per column, bound positionally. */
	insert: string;
	/** One tuple per readable row, positional against the insert's columns. */
	rows: SqlValue[][];
};

/**
 * Quote a SQL identifier, doubling embedded quotes, so any field name is safe. The single
 * quoter for every statement JS assembles: the query builder (`query.ts`) reuses it, so a table
 * or column name is never quoted by hand in JS-built SQL. The one place quoting lives elsewhere is
 * Rust's `drop_mirror_table`, which receives a bare folder name (not built SQL) and applies the same
 * doubling, trivial and identical, kept in sync by eye.
 */
export function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a value as a SQL string literal (single quotes, doubled inside): the projector's FTS5
 *  `content=` option (the base table named as a string, not an identifier) and the query builder's
 *  FTS5 MATCH literal both quote through this one implementation, beside {@link quoteIdent}. */
export function quoteString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Serialize one OK (validated) cell value to its storage class. The value passed the
 * field's schema, so the kind determines the encoding: booleans to 0/1, lists to JSON
 * text, everything else to its TEXT/INTEGER/REAL form.
 */
function serializeCell(field: Field, value: unknown): SqlValue {
	switch (field.kind) {
		case 'integer':
		case 'number':
			return value as number;
		case 'boolean':
			return value ? 1 : 0;
		case 'tags':
		case 'multiSelect':
		case 'json':
			return JSON.stringify(value); // an array or arbitrary JSON payload -> JSON TEXT
		default:
			// string / url / date / instant / datetime / select, all TEXT columns.
			// String(v) is identity for a string and the TEXT form for a numeric/boolean
			// enum value (what a select holds), which SQLite's TEXT affinity stores and
			// coerces on read.
			return String(value);
	}
}

/**
 * Serialize an out-of-domain (INVALID) cell value by its RUNTIME type, not the field's
 * kind: the value did not match the kind, so a stray float in an integer field stays a
 * real and a string in a tags field stays text. SQLite stores it regardless of the
 * column's affinity, so the draft is still findable on that field. Missing cells never
 * reach here (they bind NULL directly); the `null` guard is only defensive.
 */
function serializeInvalid(value: unknown): SqlValue {
	if (value == null) return null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'number') return value;
	if (typeof value === 'string') return value;
	return JSON.stringify(value); // an object / array where a scalar was expected
}

/** The columns every mirror table carries besides its typed fields. */
const FIXED_COLUMNS = ['stem', '_extra', 'body'];

/**
 * Which typed fields get a column of their own. SQLite column names are case-insensitive, so a
 * field named like a fixed column (`body`, `stem`, `_extra`) or like an earlier field (`Title`
 * after `title`) would make the `CREATE TABLE` fail with "duplicate column name" and leave the
 * folder with no mirror at all. Such a field keeps its typed cell in the grid; in the mirror its
 * value rides in `_extra` like an untyped key, so the folder stays queryable.
 */
function hasOwnColumn(
	fields: readonly Field[],
): (field: Field, index: number) => boolean {
	const taken = new Set(FIXED_COLUMNS);
	const own = fields.map((field) => {
		const key = field.name.toLowerCase();
		if (taken.has(key)) return false;
		taken.add(key);
		return true;
	});
	return (_field, index) => own[index] ?? false;
}

/**
 * Build the `CREATE TABLE` for a folder: `stem` primary key (the row's reference
 * identity, basename without `.md` — the exact value a reference field stores, so a
 * cross-table JOIN matches references directly with no `.md` juggling), one NULLABLE
 * column per typed field (typed by its storage class so the filter coerces by affinity;
 * a missing cell binds NULL), and an `_extra` JSON column (always present) for the
 * untyped keys, so an agent can see extras too.
 */
function buildDdl(tableName: string, fields: readonly Field[]): string {
	const defs = [
		`${quoteIdent('stem')} TEXT PRIMARY KEY`,
		...fields
			.filter(hasOwnColumn(fields))
			.map((c) => `${quoteIdent(c.name)} ${storageOf(c.kind)}`),
		`${quoteIdent('_extra')} TEXT NOT NULL`,
		`${quoteIdent('body')} TEXT`,
	];
	return `CREATE TABLE ${quoteIdent(tableName)} (${defs.join(', ')})`;
}

/**
 * The name of a folder's FTS5 index table. The `_fts` suffix is a reserved namespace in the shared
 * per-vault db (two sibling folders `x` and `x_fts` would collide, an accepted edge for a name that
 * pathological). Shared with the query builder so the projector and the reader name the index by one
 * convention, not two.
 */
export function ftsTableName(tableName: string): string {
	return `${tableName}_fts`;
}

/**
 * The FTS5 `CREATE` block for a searchable folder: an external-content virtual table over the base
 * table plus the ONE `AFTER INSERT` trigger that the full-rebuild INSERT loop fires to fill it. The
 * projector never UPDATEs or DELETEs a base row (it drops and recreates the whole table), so the
 * workspace reference's `AFTER DELETE` / `AFTER UPDATE` triggers are not needed; add them only if
 * incremental sync ever lands. The base table keeps an implicit `rowid` (a TEXT primary key is not
 * WITHOUT ROWID), so `content_rowid=rowid` works. The matching `DROP` is emitted unconditionally by
 * the caller (so losing searchability cannot leave a stale index), not here.
 */
function buildFtsSchema(
	tableName: string,
	searchable: readonly string[],
): string {
	const fts = ftsTableName(tableName);
	const cols = searchable.map(quoteIdent).join(', ');
	const newCols = searchable.map((c) => `new.${quoteIdent(c)}`).join(', ');
	return [
		`CREATE VIRTUAL TABLE ${quoteIdent(fts)} USING fts5(${cols}, content=${quoteString(tableName)}, content_rowid=rowid)`,
		`CREATE TRIGGER ${quoteIdent(`${tableName}_fts_ai`)} AFTER INSERT ON ${quoteIdent(tableName)} BEGIN\n` +
			`  INSERT INTO ${quoteIdent(fts)}(rowid, ${cols}) VALUES (new.rowid, ${newCols});\n` +
			`END`,
	].join(';\n');
}

/**
 * Project a classified folder into the SQLite artifacts. `tableName` is the SQL table's name
 * (the folder's name, so a cross-table JOIN can refer to it), quoted through {@link quoteIdent}.
 * EVERY readable row is included; each cell is serialized by its conformance state (OK by storage
 * class, INVALID by its raw value, MISSING_REQUIRED/MISSING_OPTIONAL as NULL) and its untyped keys
 * are folded into the `_extra` JSON object. The cells are read off `RowConformance.cells`, which
 * classifyRow built in `contract.fields` order, so they line up positionally with the columns below.
 */
export function projectToSqlite(
	tableName: string,
	contract: Contract,
	conformance: readonly RowConformance[],
): SqliteProjection {
	const ownColumn = hasOwnColumn(contract.fields);
	const columnFields = contract.fields.filter(ownColumn);
	const columns = [
		'stem',
		...columnFields.map((c) => c.name),
		'_extra',
		'body',
	];
	const rows = conformance.map((c) => {
		const cells = c.cells.filter((cell, index) => ownColumn(cell.field, index));
		// A field without its own column keeps its frontmatter value in `_extra`.
		const folded = contract.fields
			.filter((field, index) => !ownColumn(field, index))
			.filter((field) => Object.hasOwn(c.row.frontmatter, field.name))
			.map((field) => [field.name, c.row.frontmatter[field.name]] as const);
		const values = cells.map((cell): SqlValue => {
			switch (cell.state) {
				case 'MISSING_REQUIRED':
				case 'MISSING_OPTIONAL':
					return null;
				case 'OK':
					return serializeCell(cell.field, cell.value);
				case 'INVALID':
					return serializeInvalid(cell.raw);
				default:
					return cell satisfies never;
			}
		});
		const extra = JSON.stringify(
			Object.fromEntries([
				...folded,
				...c.extras.map((e) => [e.key, e.value] as const),
			]),
		);
		// The body is the row's markdown prose, projected verbatim so the FTS5 index can search it.
		return [stemOf(c.row.fileName), ...values, extra, c.row.body];
	});

	const placeholders = columns.map(() => '?').join(', ');
	const insert = `INSERT INTO ${quoteIdent(tableName)} (${columns
		.map(quoteIdent)
		.join(', ')}) VALUES (${placeholders})`;

	// DROP + CREATE as one param-less script; the command runs it via execute_batch, rusqlite's idiom
	// for a multi-statement setup script. Both the base table and the FTS index are dropped first,
	// ALWAYS: dropping the FTS index even when this rebuild is not searchable is what stops a folder
	// that just lost its `searchable` columns from leaving a stale index that would match wrong rows.
	// When the folder is searchable, the FTS5 virtual table and its AFTER INSERT trigger ride along so
	// the INSERT loop below populates the index for free.
	const drops =
		`DROP TABLE IF EXISTS ${quoteIdent(tableName)};\n` +
		`DROP TABLE IF EXISTS ${quoteIdent(ftsTableName(tableName))}`;
	const create = buildDdl(tableName, contract.fields);
	// Index only real columns, once each: a field folded into `_extra` has no column to index, and
	// a field named `body` would otherwise list the prose column twice.
	const columnNames = new Set(columns);
	const searchable = [
		...new Set(contract.searchable.filter((name) => columnNames.has(name))),
	];
	const fts = searchable.length
		? `;\n${buildFtsSchema(tableName, searchable)}`
		: '';
	const schema = `${drops};\n${create}${fts}`;

	return { schema, insert, rows };
}

/**
 * The `CREATE TABLE` for a folder's base table (stem, the typed field columns, `_extra`, `body`), with
 * no DROP and no FTS block. The Database panel shows this so a user can see the columns SQL can query;
 * it is the same DDL {@link projectToSqlite} emits inside its schema script.
 */
export function buildCreateTable(
	tableName: string,
	contract: Contract,
): string {
	return buildDdl(tableName, contract.fields);
}
