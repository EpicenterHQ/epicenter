#!/usr/bin/env -S bun --no-install
/**
 * The Epicenter CLI: `check` and `query` a data folder by its path (ADR-0520),
 * and `generate` its `epicenter.json` from `epicenter.ts` (ADR-0527).
 *
 * `check` and `query` read the folder through `@epicenter/folder`'s
 * `readFolder`, the same reading apps use. `check` reports files that do not
 * conform. `query` answers one read-only SQL statement over an in-memory
 * projection (ADR-0494) of the files that conform, and names the files it left
 * out. Neither writes a file, executes the folder's code, reads Git, or
 * contacts a network.
 *
 * `generate` is the one command that runs the folder's code: it imports the
 * `epicenter.ts` its author wrote and writes the `epicenter.json` it
 * declares. Run it only on a folder whose code you trust, as you would any
 * script.
 */
import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	DECLARATION_PATH,
	defineFolder,
	describeTables,
	formatDeclaration,
	type ProjectedTable,
	projectionProblem,
	projectTables,
	readFolder,
	readingStatementProblem,
	type SqlTarget,
} from '../packages/folder/src/bun.js';

/** The authored TypeScript declaration `generate` reads (ADR-0527). */
const SOURCE_PATH = 'epicenter.ts';

/** The two calls the projection asks of a database, over `bun:sqlite`. */
function sqlTarget(db: Database): SqlTarget {
	return {
		run: (sql, parameters = []) => db.run(sql, [...parameters]),
		transaction: (run) => db.transaction(run).immediate(),
	};
}

/** Whether `path` is a file; only that is ever asked of `epicenter.ts` outside `generate`. */
function isFile(path: string) {
	return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

const usage = `Usage:
  epicenter check <dir> [--json]
  epicenter query <dir> [<sql>] [--json]
  epicenter generate <dir>

check prints one line per file that does not conform. query without a
statement describes the folder's tables; with one, it runs that single
read-only statement over the files that conform and prints tab-separated rows.
A file that does not conform is left out of every table, and query names it on
stderr (in "excluded" with --json); check says why.

check exits 0 when every file conforms and 1 when one does not. query exits 0
when it answers. Both exit 2 when the folder, the declaration, or the
statement cannot be used, and check also when a file cannot be read.

generate runs <dir>/epicenter.ts, whose default export is defineFolder({...})
from @epicenter/folder, and writes the epicenter.json it declares. It is the
only command that runs a folder's code; check and query read only
epicenter.json. It may import @epicenter/folder, @epicenter/definition,
typebox, and their subpaths from this checkout. It exits 0, or 2 when
epicenter.ts cannot be used. To confirm the file is current, run generate and
then git diff --exit-code -- <dir>/epicenter.json.`;

/** One finding, located as precisely as the source allows. */
type Finding = { path: string; line?: number; field?: string; message: string };

type Row = { stem: string; fields: Record<string, unknown>; body: string };

type Table = ProjectedTable & {
	fields: { name: string; schema: object }[];
	rows: Row[];
};

/** The fields of the folder package's read errors that a finding draws on. */
type ReadError = {
	name: string;
	message: string;
	reason?: string;
	issues?: readonly Omit<Finding, 'path'>[];
};

/** An error ends the command: JSON on stdout with `--json`, otherwise stderr. */
function printError(message: string, json: boolean) {
	if (json)
		process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
	else process.stderr.write(`${message}\n`);
}

function messageOf(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function count(n: number, noun: string) {
	return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Read the data folder through the folder package's `readFolder`, the same
 * reading apps use, and sort what it reports. A file to fix in the folder is
 * `invalid`: a row or `kv.json` that does not conform, bytes that are not
 * UTF-8, or a path the folder cannot hold, such as a symbolic link. What could
 * not be read at all is `unreadable`. A folder or declaration that cannot be
 * used throws.
 */
async function readDataFolder(dir: string) {
	const { data: folder, error } = await readFolder(dir);
	if (error !== null)
		throw new Error(
			error.name === 'NotDataFolder' && isFile(resolve(dir, SOURCE_PATH))
				? `${error.message}; run \`epicenter generate ${dir}\` to write it from ${SOURCE_PATH}`
				: error.message,
		);
	const invalid: Finding[] = [];
	const unreadable: Finding[] = [];
	function report(path: string, failure: ReadError) {
		if (failure.issues)
			for (const issue of failure.issues) invalid.push({ path, ...issue });
		else if (failure.name === 'InvalidUtf8')
			invalid.push({ path, message: 'The file is not valid UTF-8 text' });
		else if (failure.name === 'InvalidPath')
			invalid.push({
				path,
				message: `The path is not usable: ${failure.reason}`,
			});
		else if (failure.name === 'NotAFile')
			invalid.push({ path, message: 'A row must be a file, not a directory' });
		else unreadable.push({ path, message: failure.message });
	}

	const tables: Table[] = [];
	for (const [name, listed] of Object.entries(folder.tables)) {
		const table: Table = {
			name,
			fields: Object.entries(folder.definition.tables[name]?.fields ?? {}).map(
				([field, schema]) => ({ name: field, schema }),
			),
			rows: [],
		};
		tables.push(table);
		if (listed.error !== null) {
			report(name, listed.error);
			continue;
		}
		// A listing has no promised order; sorting keeps output stable.
		for (const { stem, result } of [...listed.data].sort((a, b) =>
			a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0,
		)) {
			if (result.error !== null) report(`${name}/${stem}.md`, result.error);
			else
				table.rows.push({
					stem,
					fields: result.data.row.fields,
					body: result.data.row.body,
				});
		}
	}
	if (folder.kv.error !== null) report('kv.json', folder.kv.error);
	else
		for (const issue of folder.kv.data?.issues ?? [])
			invalid.push({ path: 'kv.json', ...issue });
	return { tables, invalid, unreadable };
}

/**
 * `path:line: message`, compiler style. The message already names its field,
 * so the field stays in `--json` rather than the text.
 */
function formatFinding({ path, line, message }: Finding) {
	return `${line === undefined ? path : `${path}:${line}`}: ${message}`;
}

/** Files with at least one finding, so a row with three issues counts once. */
function fileCount(findings: Finding[]) {
	return new Set(findings.map(({ path }) => path)).size;
}

// ============================================================================
// check
// ============================================================================

async function check(dir: string, json: boolean) {
	const { tables, invalid, unreadable } = await readDataFolder(dir);
	const rows = tables.reduce((sum, table) => sum + table.rows.length, 0);
	const exitCode = unreadable.length ? 2 : invalid.length ? 1 : 0;
	// Only whether the file exists: check never runs it.
	const note = isFile(resolve(dir, SOURCE_PATH))
		? `${DECLARATION_PATH} is generated from ${SOURCE_PATH}; edit the .ts and run \`epicenter generate ${dir}\`, not the .json.`
		: undefined;
	process.stdout.write(
		json
			? `${JSON.stringify({ rows, invalid, unreadable, exitCode, ...(note ? { source: SOURCE_PATH } : {}) }, null, 2)}\n`
			: `${[
					...(note ? [note] : []),
					...unreadable.map(formatFinding),
					...invalid.map(formatFinding),
					`${count(rows, 'row')} ${rows === 1 ? 'conforms' : 'conform'}; ${count(fileCount(invalid), 'file')} invalid; ${unreadable.length} unreadable.`,
				].join('\n')}\n`,
	);
	return exitCode;
}

// ============================================================================
// query
// ============================================================================

const TRAILING_TRIVIA = /--[^\n]*|\/\*[\s\S]*?\*\/|[\s;]/g;

/**
 * Prepare exactly one statement that only reads. The folder package refuses
 * a statement that does not start with a reading keyword; SQLite prepares
 * only the first of several statements, so anything after it is refused
 * rather than silently ignored.
 */
function prepareRead(db: Database, sql: string) {
	const problem = readingStatementProblem(sql);
	if (problem !== undefined) throw new Error(problem);
	const statement = db.query(sql);
	if (sql.slice(statement.toString().length).replace(TRAILING_TRIVIA, ''))
		throw new Error(
			'query runs one statement; remove everything after the first',
		);
	return statement;
}

/**
 * Rows as tab-separated text with a header. Backslash, tab, newline, and
 * carriage return are escaped, so every row is one line and splits exactly.
 */
function formatRows(columns: string[], rows: Record<string, unknown>[]) {
	const cell = (value: unknown) =>
		value === null || value === undefined
			? ''
			: String(value)
					.replaceAll('\\', '\\\\')
					.replaceAll('\t', '\\t')
					.replaceAll('\n', '\\n')
					.replaceAll('\r', '\\r');
	return [
		columns.join('\t'),
		...rows.map((row) => columns.map((column) => cell(row[column])).join('\t')),
	].join('\n');
}

async function query(dir: string, sql: string | undefined, json: boolean) {
	const { tables, invalid, unreadable } = await readDataFolder(dir);
	if (sql === undefined) {
		const description = describeTables(tables);
		process.stdout.write(
			json
				? `${JSON.stringify({ tables: description }, null, 2)}\n`
				: `${description
						.flatMap((table) => [
							`${table.name}:`,
							...table.columns.map(
								({ name, values }) => `  ${name}: ${values}`,
							),
						])
						.join('\n')}\n`,
		);
		return 0;
	}
	for (const table of tables) {
		const problem = projectionProblem(table);
		if (problem !== undefined) throw new Error(problem);
	}
	// A file that does not conform is left out whole and named, never read in part.
	const excluded = [
		...new Set([...unreadable, ...invalid].map(({ path }) => path)),
	];
	const db = new Database(':memory:');
	try {
		projectTables(sqlTarget(db), tables);
		const statement = prepareRead(db, sql);
		const rows = statement.all() as Record<string, unknown>[];
		const columns = statement.columnNames;
		process.stdout.write(
			json
				? `${JSON.stringify({ columns, rows, excluded }, null, 2)}\n`
				: `${formatRows(columns, rows)}\n`,
		);
		if (excluded.length && !json)
			process.stderr.write(
				`${count(excluded.length, 'file')} excluded because ${excluded.length === 1 ? 'it does' : 'they do'} not conform: ${excluded.join(', ')}. Run \`epicenter check ${dir}\`\n`,
			);
		return 0;
	} finally {
		db.close();
	}
}

// ============================================================================
// generate
// ============================================================================

/**
 * What a folder's `epicenter.ts` may import without installing anything, and
 * whether the module has a default export. A data folder lives in any
 * repository, so these names resolve to this checkout's packages, and a copy
 * the folder installed never wins. Bun ignores a runtime redirect of a bare
 * specifier, so each name is listed.
 */
const DECLARATION_IMPORTS: readonly [
	specifier: string,
	withDefault: boolean,
][] = [
	['@epicenter/folder', false],
	['@epicenter/folder/bun', false],
	['@epicenter/definition', false],
	['@epicenter/definition/field', false],
	['typebox', true],
	['typebox/compile', false],
	['typebox/format', false],
	['typebox/schema', false],
	['typebox/system', false],
	['typebox/value', false],
];

function resolveEpicenterImports() {
	const folder = resolve(import.meta.dir, '../packages/folder');
	const definition = resolve(import.meta.dir, '../packages/definition');
	Bun.plugin({
		name: 'epicenter-declaration-imports',
		setup(build) {
			for (const [specifier, withDefault] of DECLARATION_IMPORTS) {
				const path = JSON.stringify(
					Bun.resolveSync(
						specifier,
						specifier.startsWith('@epicenter/folder') ? folder : definition,
					),
				);
				build.module(specifier, () => ({
					contents: `export * from ${path};${withDefault ? ` export { default } from ${path};` : ''}`,
					loader: 'ts',
				}));
			}
		},
	});
}

async function generate(dir: string) {
	const source = resolve(dir, SOURCE_PATH);
	if (!isFile(source))
		throw new Error(`'${dir}' has no ${SOURCE_PATH} to generate from`);
	resolveEpicenterImports();
	let declared: unknown;
	try {
		declared = (await import(pathToFileURL(source).href)).default;
	} catch (error) {
		throw new Error(`${source} could not run: ${messageOf(error)}`);
	}
	if (typeof declared !== 'object' || declared === null)
		throw new Error(
			`${SOURCE_PATH} must \`export default defineFolder({ kv, tables })\``,
		);
	// defineFolder refuses what a folder cannot keep, and returns a prepared
	// definition as it is.
	const text = formatDeclaration(
		defineFolder(declared as Parameters<typeof defineFolder>[0]),
	);
	const target = resolve(dir, DECLARATION_PATH);
	const unchanged = isFile(target) && (await readFile(target, 'utf8')) === text;
	if (!unchanged) await writeFile(target, text);
	process.stdout.write(
		`${unchanged ? 'unchanged' : 'wrote'} ${DECLARATION_PATH} from ${SOURCE_PATH}\n`,
	);
	return 0;
}

if (import.meta.main) {
	// Options are matched exactly, so a statement that starts with `--` stays a statement.
	const args = Bun.argv.slice(2);
	const json = args.includes('--json');
	const [command, dir, sql, ...extra] = args.filter((arg) => arg !== '--json');
	try {
		if (command === '--help' || command === '-h' || command === undefined)
			process.stdout.write(`${usage}\n`);
		else if (command === 'check' && dir && sql === undefined)
			process.exitCode = await check(dir, json);
		else if (command === 'query' && dir && !extra.length)
			process.exitCode = await query(dir, sql, json);
		else if (command === 'generate' && dir && sql === undefined && !json)
			process.exitCode = await generate(dir);
		else if (command === 'generate' && dir)
			throw new Error(
				'generate takes only a directory; run `git diff --exit-code` on epicenter.json to see whether it changed',
			);
		else throw new Error(usage);
	} catch (error) {
		// A thrown error is the tool failing: a bad declaration, statement, or command.
		printError(messageOf(error), json);
		process.exitCode = 2;
	}
}
