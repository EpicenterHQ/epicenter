import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { SnapshotRow, SqliteValue } from '@epicenter/record-sync';
import { Value } from 'typebox/value';
import type { KvDefinitions } from '../document/kv.js';
import type { AsyncWorkspace } from './client.js';
import type {
	CompiledColumn,
	TableDefinitions,
	WorkspaceDefinition,
} from './definition.js';
import type { WorkspaceDocumentOpener } from './document-client.js';
import {
	type CollectPortableWorkspaceOptions,
	collectPortableWorkspace,
	PORTABLE_WORKSPACE_FORMAT,
	type PortableFileManifest,
	type PortableWorkspaceManifest,
} from './portable-workspace.js';
import { canonicalJson } from './schema-descriptor.js';

const SHA256_TOKEN = /^sha256:[0-9a-f]{64}$/;

type ExportableWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = AsyncWorkspace<TTables, WorkspaceDocumentOpener | undefined> & {
	readonly kv:
		| {
				get(key: keyof TKv & string): unknown;
		  }
		| undefined;
};

export type ExportPortableWorkspaceOptions = CollectPortableWorkspaceOptions & {
	/** A new directory. Existing paths are never replaced. */
	directory: string;
};

/** Read an edited export database after validating its sibling manifest. */
export function readPortableTables(
	definition: WorkspaceDefinition,
	tablesPathInput: string,
): readonly SnapshotRow[] {
	const tablesPath = resolve(tablesPathInput);
	const manifestPath = join(dirname(tablesPath), 'workspace.json');
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
	assertManifestIdentity(definition, manifest);
	if (basename(tablesPath) !== manifest.content.tables.path) {
		throw new Error('Portable tables path does not match workspace.json');
	}
	const database = new Database(tablesPath, { readonly: true, strict: true });
	try {
		const actualTables = database
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all()
			.map(({ name }) => name);
		const expectedTables = Object.keys(definition.tables).toSorted();
		if (canonicalJson(actualTables) !== canonicalJson(expectedTables)) {
			throw new Error('Portable tables database has unexpected tables');
		}

		const rows: SnapshotRow[] = [];
		for (const tableName of expectedTables) {
			const table = definition.tables[tableName];
			if (!table) throw new Error(`Unknown portable table '${tableName}'`);
			const columns = table.compiledColumns as Record<string, CompiledColumn>;
			const storedColumns = database
				.query<{ name: string; type: string; notnull: number; pk: number }, []>(
					`PRAGMA table_info(${quoteIdentifier(tableName)})`,
				)
				.all()
				.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
			const expectedColumns = Object.entries(columns).map(([name, column]) => ({
				name,
				type: column.storage,
				notnull: column.isNullable ? 0 : 1,
				pk: name === 'id' ? 1 : 0,
			}));
			if (canonicalJson(storedColumns) !== canonicalJson(expectedColumns)) {
				throw new Error(
					`Portable table '${tableName}' does not match the locked schema`,
				);
			}
			const storedRows = database
				.query<Record<string, SqliteValue>, []>(
					`SELECT ${Object.keys(columns).map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(tableName)} ORDER BY "id"`,
				)
				.all();
			for (const stored of storedRows) {
				const row = Object.fromEntries(
					Object.entries(columns).map(([name, column]) => [
						name,
						decodeColumn(column, stored[name] ?? null),
					]),
				);
				if (!Value.Check(table.schema, row)) {
					throw new Error(
						`Portable row in '${tableName}' does not match the locked schema`,
					);
				}
				const { id, ...cells } = row;
				rows.push({
					table: tableName,
					rowId: id as string,
					cells: cells as SnapshotRow['cells'],
				});
			}
		}
		return Object.freeze(rows);
	} finally {
		database.close();
	}
}

/** Write one complete, immutable portable workspace folder. */
export async function exportPortableWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	workspace: ExportableWorkspace<TTables, TKv>,
	options: ExportPortableWorkspaceOptions,
): Promise<PortableWorkspaceManifest> {
	const target = resolve(options.directory);
	if (existsSync(target)) {
		throw new Error(`Portable export destination already exists: ${target}`);
	}
	const parent = dirname(target);
	mkdirSync(parent, { recursive: true });
	const temporary = join(
		parent,
		`.${basename(target)}.epicenter-export-${randomUUID()}`,
	);
	mkdirSync(temporary, { recursive: false });

	try {
		const content = await collectPortableWorkspace(
			definition,
			workspace as Parameters<typeof collectPortableWorkspace<TTables, TKv>>[1],
			options,
		);
		const tablesPath = join(temporary, 'tables.sqlite3');
		writeTablesDatabase(definition, content.rows, tablesPath);
		const kvPath = join(temporary, 'kv.json');
		writeFileSync(kvPath, `${JSON.stringify(content.kv, null, 2)}\n`);

		mkdirSync(join(temporary, 'documents'));
		const writtenDocuments = new Set<string>();
		for (const document of content.documents) {
			if (writtenDocuments.has(document.hash)) continue;
			writeFileSync(
				join(temporary, 'documents', `${document.hash}.yjs`),
				document.bytes,
			);
			writtenDocuments.add(document.hash);
		}
		mkdirSync(join(temporary, 'blobs'));
		for (const blob of content.blobs) {
			writeFileSync(join(temporary, 'blobs', blob.hash), blob.bytes);
		}

		const manifest: PortableWorkspaceManifest = Object.freeze({
			format: PORTABLE_WORKSPACE_FORMAT,
			appId: definition.appId,
			version: definition.version,
			workspaceId: definition.workspaceId,
			lockEntry: definition.proposedLockEntry,
			tablesStateHash: content.tablesStateHash,
			content: Object.freeze({
				tables: Object.freeze({
					...fileManifest(temporary, tablesPath),
					rows: content.rows.length,
				}),
				kv: Object.freeze({
					...fileManifest(temporary, kvPath),
					keys: Object.keys(content.kv).length,
				}),
				documents: Object.freeze(
					content.documents.map((document) =>
						Object.freeze({
							path: `documents/${document.hash}.yjs`,
							hash: document.hash,
							size: document.bytes.byteLength,
							table: document.table,
							rowId: document.rowId,
							field: document.field,
							guid: document.guid,
							formatHash: document.formatHash,
						}),
					),
				),
				blobs: Object.freeze(
					content.blobs.map((blob) =>
						Object.freeze({
							path: `blobs/${blob.hash}`,
							hash: blob.hash,
							size: blob.size,
							mediaType: blob.mediaType,
						}),
					),
				),
			}),
		});
		writeFileSync(
			join(temporary, 'workspace.json'),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
		renameSync(temporary, target);
		return manifest;
	} catch (cause) {
		rmSync(temporary, { recursive: true, force: true });
		throw cause;
	}
}

function writeTablesDatabase(
	definition: WorkspaceDefinition,
	rows: readonly {
		table: string;
		rowId: string;
		cells: Readonly<Record<string, unknown>>;
	}[],
	path: string,
): void {
	const database = new Database(path, { create: true, strict: true });
	try {
		database.exec('PRAGMA journal_mode = DELETE');
		database.exec('BEGIN IMMEDIATE');
		try {
			for (const [tableName, table] of Object.entries(definition.tables)) {
				const columns = table.compiledColumns as Record<string, CompiledColumn>;
				const ddl = Object.entries(columns).map(([name, column]) => {
					const nullability = column.isNullable ? '' : ' NOT NULL';
					return name === 'id'
						? `${quoteIdentifier(name)} TEXT PRIMARY KEY NOT NULL`
						: `${quoteIdentifier(name)} ${column.storage}${nullability}`;
				});
				database.run(
					`CREATE TABLE ${quoteIdentifier(tableName)} (${ddl.join(', ')})`,
				);
			}
			for (const row of rows) {
				const table = definition.tables[row.table];
				if (!table) throw new Error(`Unknown portable table '${row.table}'`);
				const columns = Object.entries(
					table.compiledColumns as Record<string, CompiledColumn>,
				);
				database.run(
					`INSERT INTO ${quoteIdentifier(row.table)} (${columns.map(([name]) => quoteIdentifier(name)).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
					columns.map(([name, column]) =>
						encodeColumn(column, name === 'id' ? row.rowId : row.cells[name]),
					) as SQLQueryBindings[],
				);
			}
			database.exec('COMMIT');
		} catch (cause) {
			if (database.inTransaction) database.exec('ROLLBACK');
			throw cause;
		}
	} finally {
		database.close();
	}
}

function encodeColumn(
	column: CompiledColumn,
	value: unknown,
): SQLQueryBindings {
	if (!column.check(value)) {
		throw new Error(`Portable value for '${column.name}' failed validation`);
	}
	if (value === null) return null;
	switch (column.kind) {
		case 'boolean':
			return value ? 1 : 0;
		case 'json':
		case 'multiSelect':
		case 'tags':
			return JSON.stringify(value);
		default:
			return value as SQLQueryBindings;
	}
}

function decodeColumn(column: CompiledColumn, value: SqliteValue): unknown {
	if (value === null) {
		if (!column.check(null)) {
			throw new Error(
				`Portable value for '${column.name}' is unexpectedly null`,
			);
		}
		return null;
	}
	let decoded: unknown;
	switch (column.kind) {
		case 'boolean':
			if (value !== 0 && value !== 1) {
				throw new Error(`Portable value for '${column.name}' is not a boolean`);
			}
			decoded = value === 1;
			break;
		case 'json':
		case 'multiSelect':
		case 'tags':
			decoded = JSON.parse(String(value));
			break;
		default:
			decoded = value;
	}
	if (!column.check(decoded)) {
		throw new Error(`Portable value for '${column.name}' failed validation`);
	}
	return decoded;
}

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function fileManifest(root: string, path: string): PortableFileManifest {
	const bytes = readFileSync(path);
	return {
		path: path.slice(root.length + 1),
		hash: createHash('sha256').update(bytes).digest('hex'),
		size: bytes.byteLength,
	};
}

function assertManifestIdentity(
	definition: WorkspaceDefinition,
	value: unknown,
): asserts value is PortableWorkspaceManifest {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw new Error('Invalid portable workspace manifest');
	}
	const manifest = value as Partial<PortableWorkspaceManifest>;
	if (
		!hasExactKeys(value as Record<string, unknown>, [
			'appId',
			'content',
			'format',
			'lockEntry',
			'tablesStateHash',
			'version',
			'workspaceId',
		]) ||
		manifest.format !== PORTABLE_WORKSPACE_FORMAT ||
		manifest.appId !== definition.appId ||
		manifest.version !== definition.version ||
		manifest.workspaceId !== definition.workspaceId ||
		typeof manifest.tablesStateHash !== 'string' ||
		!SHA256_TOKEN.test(manifest.tablesStateHash) ||
		canonicalJson(manifest.lockEntry) !==
			canonicalJson(definition.proposedLockEntry) ||
		manifest.content?.tables?.path !== 'tables.sqlite3'
	) {
		throw new Error(
			'Portable workspace manifest does not match the locked definition',
		);
	}
}

function hasExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const actual = Object.keys(value).toSorted();
	return canonicalJson(actual) === canonicalJson([...expected].toSorted());
}
