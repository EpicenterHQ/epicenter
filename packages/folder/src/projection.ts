/**
 * A data folder as SQL: the projection `epicenter query` reads and an
 * application's SQL view can read the same way (ADR-0520, ADR-0494).
 *
 * Each declared table becomes one SQLite table with `id` (the row's file is
 * `<table>/<id>.md`), one quoted column per declared field, and `body`. A
 * null or absent value is `NULL`, a boolean is `0` or `1`, a list or object is
 * JSON text, and strings and numbers are stored as they are. Only rows that
 * conform are projected; the caller names the files it left out.
 *
 * The projection needs only {@link SqlTarget}, two calls every embedded SQLite
 * binding has, so Bun and a browser's SQLite build it identically without this
 * package depending on either. Preparing a caller's statement stays with the
 * engine, which is the only one that can tell where it ends.
 */

/** A value SQLite stores for a projected column. */
type SqlValue = string | number | null;

/**
 * What the projection asks of a database: run one statement, and run several
 * as one transaction. `queryFolder` (`query-folder.ts`) adapts a `bun:sqlite`
 * database to it.
 */
export type SqlTarget = {
	run(sql: string, parameters?: readonly SqlValue[]): void;
	transaction<TResult>(run: () => TResult): TResult;
};

/** One declared table and the rows that conform, ready to project. */
export type ProjectedTable = {
	readonly name: string;
	readonly fields: readonly {
		readonly name: string;
		readonly schema: object;
	}[];
	readonly rows: readonly {
		readonly id: string;
		readonly fields: Readonly<Record<string, unknown>>;
		readonly body: string;
	}[];
};

/** Columns the projection adds beside the declared fields. */
const ROW_COLUMNS = ['id', 'body'];

/** A SQL identifier, quoted, because declared field names may be keywords. */
function quote(name: string) {
	return `"${name.replaceAll('"', '""')}"`;
}

/** A field value as SQLite stores it: JSON text for lists and objects. */
function toSql(value: unknown): SqlValue {
	if (value === undefined || value === null) return null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'object') return JSON.stringify(value);
	return value as string | number;
}

/**
 * Why a table cannot be one SQLite table, or `undefined` when it can. SQLite
 * compares column names without case, and `id` and `body` are the
 * projection's own columns.
 */
export function projectionProblem(table: ProjectedTable): string | undefined {
	const seen = new Map(ROW_COLUMNS.map((column) => [column, column]));
	for (const { name } of table.fields) {
		const other = seen.get(name.toLowerCase());
		if (other !== undefined)
			return ROW_COLUMNS.includes(other)
				? `table '${table.name}' declares a field '${name}', but query uses '${other}' for the row itself`
				: `table '${table.name}' declares '${other}' and '${name}', which differ only by case`;
		seen.set(name.toLowerCase(), name);
	}
	return undefined;
}

/**
 * Create one table per declared table in `db` and insert its rows, then make
 * the database read-only, so a statement that changes rows fails rather than
 * appearing to succeed. Throws when a table has a {@link projectionProblem}.
 */
export function projectTables(
	db: SqlTarget,
	tables: readonly ProjectedTable[],
): void {
	for (const table of tables) {
		const problem = projectionProblem(table);
		if (problem !== undefined) throw new Error(problem);
	}
	db.transaction(() => {
		for (const table of tables) {
			const fields = table.fields.map(({ name }) => quote(name));
			db.run(
				`CREATE TABLE ${quote(table.name)} (id TEXT PRIMARY KEY, ${[...fields, 'body'].join(', ')})`,
			);
			const insert = `INSERT INTO ${quote(table.name)} VALUES (${['?', ...fields.map(() => '?'), '?'].join(', ')})`;
			for (const row of table.rows)
				db.run(insert, [
					row.id,
					...table.fields.map(({ name }) => toSql(row.fields[name])),
					row.body,
				]);
		}
	});
	db.run('PRAGMA query_only = ON');
}

const LEADING_TRIVIA = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
/** The keywords a statement over the projection may start with. */
const READING_KEYWORDS = ['SELECT', 'WITH', 'VALUES', 'EXPLAIN'];

/**
 * Why `sql` may not run over the projection, or `undefined` when its first
 * keyword reads. `query_only` stops changes to the projection, but not
 * `ATTACH` or `VACUUM INTO`, which create files, so a statement must start
 * with a reading keyword. The engine that prepares it still refuses anything
 * after the first statement.
 */
export function readingStatementProblem(sql: string): string | undefined {
	const keyword = sql
		.replace(LEADING_TRIVIA, '')
		.match(/^[A-Za-z]+/)?.[0]
		?.toUpperCase();
	if (!keyword) return 'query takes one SQL statement; this one is empty';
	if (!READING_KEYWORDS.includes(keyword))
		return `query only reads: a statement must start with SELECT, WITH, VALUES, or EXPLAIN, not ${keyword}`;
	return undefined;
}

/**
 * What a field holds, read for a person writing SQL: its allowed values when
 * it has them, otherwise its JSON Schema type, format, or reference target.
 */
function valuesOf(schema: object): string {
	const node = schema as {
		const?: unknown;
		enum?: unknown[];
		anyOf?: object[];
		type?: string | string[];
		format?: string;
		items?: object;
		'x-field'?: { kind?: string; target?: string };
	};
	const literal = (value: unknown) =>
		typeof value === 'string' ? value : JSON.stringify(value);
	if ('const' in node) return literal(node.const);
	if (Array.isArray(node.enum)) return node.enum.map(literal).join('|');
	if (Array.isArray(node.anyOf)) return node.anyOf.map(valuesOf).join('|');
	if (node['x-field']?.kind === 'reference' && node['x-field'].target)
		return `id in ${node['x-field'].target}`;
	if (node.format) return node.format;
	if (node.type === 'array' && node.items)
		return `list of ${valuesOf(node.items)}`;
	if (node.type) return [node.type].flat().join('|');
	return 'any JSON';
}

/** The definition as SQL sees it: each table's columns and what each holds. */
export function describeTables(tables: readonly ProjectedTable[]) {
	return tables.map((table) => ({
		name: table.name,
		columns: [
			{ name: 'id', values: `the row's file is ${table.name}/<id>.md` },
			...table.fields.map(({ name, schema }) => ({
				name,
				values: valuesOf(schema),
			})),
			{ name: 'body', values: 'Markdown after the frontmatter' },
		],
	}));
}
