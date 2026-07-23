import { recognize } from '@epicenter/field';
import type { SqliteDatabase } from '@epicenter/sqlite';
import type { TSchema } from 'typebox';

import { type LensDefinition, parseLens } from '../../lens.js';
import { canonicalize, type JsonValue } from '../../protocol/v1/index.js';

export const SNAPSHOT_ARTIFACT_FORMAT_VERSION = 1;

export type SnapshotArtifactRecord = {
	namespace: string;
	collection: string;
	recordKey: string;
	payload: JsonValue;
	documentRevision: number;
	documentByteLength: number;
	documentOwed: boolean;
	blobSha256: string | null;
};

export type SnapshotArtifactMetadata = {
	kind: 'snapshot';
	formatVersion: typeof SNAPSHOT_ARTIFACT_FORMAT_VERSION;
	sourceAuthorityLifetime: string | null;
	sourceAuthorityAfterSequence: number;
	lens: LensDefinition | null;
	recordCount: number;
};

type WriteSnapshotArtifactOptions = {
	database: SqliteDatabase;
	sourceAuthorityLifetime: string | null;
	sourceAuthorityAfterSequence: number;
	records: Iterable<SnapshotArtifactRecord>;
	lens?: LensDefinition;
};

const SNAPSHOT_SCHEMA = [
	`CREATE TABLE _epicenter_artifact (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		kind TEXT NOT NULL CHECK (kind = 'snapshot'),
		format_version INTEGER NOT NULL CHECK (format_version = 1),
		source_authority_lifetime TEXT,
		source_authority_after_sequence INTEGER NOT NULL
			CHECK (source_authority_after_sequence BETWEEN 0 AND 9007199254740991),
		lens_json TEXT CHECK (lens_json IS NULL OR json_valid(lens_json))
	) STRICT`,
	`CREATE TABLE _epicenter_records (
		namespace TEXT NOT NULL,
		collection TEXT NOT NULL,
		record_key TEXT NOT NULL,
		payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
		document_revision INTEGER NOT NULL
			CHECK (document_revision BETWEEN 0 AND 9007199254740991),
		document_byte_length INTEGER NOT NULL CHECK (document_byte_length >= 0),
		document_owed INTEGER NOT NULL CHECK (document_owed IN (0, 1)),
		blob_sha256 TEXT,
		PRIMARY KEY (namespace, collection, record_key),
		CHECK (blob_sha256 IS NULL OR
			(length(blob_sha256) = 64 AND blob_sha256 NOT GLOB '*[^a-f0-9]*'))
	) STRICT, WITHOUT ROWID`,
] as const;

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function asciiFold(value: string): string {
	let folded = '';
	for (const character of value) {
		const code = character.charCodeAt(0);
		folded +=
			code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : character;
	}
	return folded;
}

function validateViewNames(lens: LensDefinition): void {
	const names = new Map<string, string>();
	for (const name of Object.keys(lens.collections)) {
		const folded = asciiFold(name);
		if (folded.startsWith('_epicenter_') || folded.startsWith('sqlite_')) {
			throw new Error(`Snapshot view name '${name}' is reserved`);
		}
		const previous = names.get(folded);
		if (previous !== undefined) {
			throw new Error(
				`Snapshot view names '${previous}' and '${name}' collide in SQLite`,
			);
		}
		names.set(folded, name);
		const definition = lens.collections[name];
		if (definition === undefined) continue;
		const columnNames =
			definition.kind === 'table'
				? ['id', ...Object.keys(definition.fields)]
				: Object.keys(definition.values);
		const columns = new Map<string, string>();
		for (const column of columnNames) {
			const foldedColumn = asciiFold(column);
			const previousColumn = columns.get(foldedColumn);
			if (previousColumn !== undefined) {
				throw new Error(
					`Snapshot view '${name}' columns '${previousColumn}' and '${column}' collide in SQLite`,
				);
			}
			columns.set(foldedColumn, column);
		}
	}
}

function jsonPath(field: string): string {
	return `$.${JSON.stringify(field)}`;
}

function guardedJsonValue(
	json: string,
	schema: TSchema,
	path?: string,
): string {
	const field = recognize(schema);
	if (field === null || field.kind === 'reference') {
		throw new Error('Snapshot Lens contains an unsupported field');
	}
	const argumentsSql =
		path === undefined ? json : `${json}, ${quoteString(path)}`;
	const jsonType = `json_type(${argumentsSql})`;
	const extracted =
		path === undefined
			? `json_extract(${json}, '$')`
			: `json_extract(${json}, ${quoteString(path)})`;
	switch (field.kind) {
		case 'boolean':
			return `CASE WHEN ${jsonType} IN ('true', 'false') THEN ${extracted} END`;
		case 'integer':
			return `CASE WHEN ${jsonType} = 'integer' THEN ${extracted} END`;
		case 'number':
			return `CASE WHEN ${jsonType} IN ('integer', 'real') THEN ${extracted} END`;
		case 'multiSelect':
		case 'tags':
			return `CASE WHEN ${jsonType} = 'array' THEN ${extracted} END`;
		case 'date':
		case 'datetime':
		case 'instant':
		case 'select':
		case 'string':
		case 'url':
			return `CASE WHEN ${jsonType} = 'text' THEN ${extracted} END`;
		case 'json':
			return `CASE WHEN ${jsonType} IS NOT NULL AND ${jsonType} != 'null' THEN ${extracted} END`;
		default:
			return field satisfies never;
	}
}

function tableViewSql(
	lens: LensDefinition,
	collection: string,
	definition: Extract<LensDefinition['collections'][string], { kind: 'table' }>,
): string {
	const columns = [
		'record_key AS id',
		...Object.entries(definition.fields).map(([name, schema]) => {
			return `${guardedJsonValue('payload_json', schema, jsonPath(name))} AS ${quoteIdentifier(name)}`;
		}),
	];
	const declaredColumns = ['id', ...Object.keys(definition.fields)]
		.map(quoteIdentifier)
		.join(', ');
	return `CREATE VIEW ${quoteIdentifier(collection)} (${declaredColumns}) AS
		SELECT ${columns.join(',\n\t\t\t')}
		FROM _epicenter_records
		WHERE namespace = ${quoteString(lens.namespace)}
			AND collection = ${quoteString(collection)}`;
}

function valuesViewSql(
	lens: LensDefinition,
	collection: string,
	definition: Extract<
		LensDefinition['collections'][string],
		{ kind: 'values' }
	>,
): string {
	const values = Object.entries(definition.values);
	const columns = values.map(
		([recordKey, schema]) =>
			`(SELECT ${guardedJsonValue('payload_json', schema)}
			FROM _epicenter_records
			WHERE namespace = ${quoteString(lens.namespace)}
				AND collection = ${quoteString(collection)}
				AND record_key = ${quoteString(recordKey)}) AS ${quoteIdentifier(recordKey)}`,
	);
	const declaredColumns = values
		.map(([recordKey]) => quoteIdentifier(recordKey))
		.join(', ');
	return `CREATE VIEW ${quoteIdentifier(collection)} (${declaredColumns}) AS
		SELECT ${columns.join(',\n\t\t\t')}`;
}

function createLensViews(database: SqliteDatabase, lens: LensDefinition): void {
	validateViewNames(lens);
	for (const [collection, definition] of Object.entries(lens.collections)) {
		database.run(
			definition.kind === 'table'
				? tableViewSql(lens, collection, definition)
				: valuesViewSql(lens, collection, definition),
		);
	}
}

function assertEmpty(database: SqliteDatabase): void {
	const objects = database.all<{ name: string }>(
		`SELECT name FROM sqlite_schema
		WHERE type IN ('table', 'view', 'index') AND name NOT LIKE 'sqlite_%'`,
	);
	if (objects.length !== 0) {
		throw new Error('Snapshot target database must be empty');
	}
}

/** Write one inert, self-identifying inspection artifact into an empty database. */
export function writeSnapshotArtifact({
	database,
	sourceAuthorityLifetime,
	sourceAuthorityAfterSequence,
	records,
	lens,
}: WriteSnapshotArtifactOptions): SnapshotArtifactMetadata {
	assertEmpty(database);
	const parsedLens = lens === undefined ? undefined : parseLens(lens);
	if (parsedLens !== undefined && parsedLens.error !== null) {
		throw parsedLens.error;
	}
	const selectedLens = parsedLens?.data;
	if (selectedLens !== undefined) validateViewNames(selectedLens);
	let recordCount = 0;
	database.transaction(() => {
		for (const statement of SNAPSHOT_SCHEMA) database.run(statement);
		database.run(
			`INSERT INTO _epicenter_artifact (
				singleton, kind, format_version, source_authority_lifetime,
				source_authority_after_sequence, lens_json
			) VALUES (1, 'snapshot', ?, ?, ?, ?)`,
			[
				SNAPSHOT_ARTIFACT_FORMAT_VERSION,
				sourceAuthorityLifetime,
				sourceAuthorityAfterSequence,
				selectedLens === undefined
					? null
					: canonicalize(selectedLens as unknown as JsonValue),
			],
		);
		for (const record of records) {
			database.run(
				`INSERT INTO _epicenter_records (
					namespace, collection, record_key, payload_json,
					document_revision, document_byte_length, document_owed, blob_sha256
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					record.namespace,
					record.collection,
					record.recordKey,
					canonicalize(record.payload),
					record.documentRevision,
					record.documentByteLength,
					record.documentOwed ? 1 : 0,
					record.blobSha256,
				],
			);
			recordCount += 1;
		}
		if (selectedLens !== undefined) createLensViews(database, selectedLens);
		const integrity = database.all<{ integrity_check: string }>(
			'PRAGMA integrity_check',
		);
		if (
			integrity.length !== 1 ||
			integrity[0]?.integrity_check.toLowerCase() !== 'ok'
		) {
			throw new Error('Snapshot artifact failed SQLite integrity check');
		}
	});
	return {
		kind: 'snapshot',
		formatVersion: SNAPSHOT_ARTIFACT_FORMAT_VERSION,
		sourceAuthorityLifetime,
		sourceAuthorityAfterSequence,
		lens: selectedLens ?? null,
		recordCount,
	};
}
