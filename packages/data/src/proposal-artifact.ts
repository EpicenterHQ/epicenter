import { recognize } from '@epicenter/field';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { TSchema } from 'typebox';

import {
	compileTableDefinition,
	compileValueDefinition,
	type LensDefinition,
	parseLens,
} from './lens.js';
import {
	canonicalize,
	type Intent,
	isNamespaceKey,
	isWellFormedString,
	type JsonValue,
	parseAddress,
	parseIntent,
	SCALAR_SYNC_V1_LIMITS,
} from './protocol/v1/index.js';

export const PROPOSAL_ARTIFACT_FORMAT_VERSION = 1;

type TableSelection = {
	kind: 'table';
	recordKeys: string[];
	allowCreate: boolean;
};

type ValuesSelection = {
	kind: 'values';
	recordKeys: string[];
};

export type ProposalSelection = {
	namespace: string;
	collections: Record<string, TableSelection | ValuesSelection>;
};

export type ProposalSourceRecord = {
	address: { namespace: string; collection: string; recordKey: string };
} & (
	| { state: 'live'; payload: JsonValue }
	| { state: 'absent'; payload?: never }
);

export type ProposalManifestEntry =
	| Intent
	| (Extract<Intent, { op: 'replace' }> & { collision: 'refuse' });

export type ProposalManifest = {
	proposalId: string;
	sourceReplicaId: string;
	sourceAuthorityLifetime: string | null;
	entries: ProposalManifestEntry[];
	appliedCount: number;
};

export type ProposalArtifactStatus = {
	proposalId: string;
	sourceReplicaId: string;
	sourceAuthorityLifetime: string | null;
	state: 'draft' | 'compiled';
	changeCount: number;
	appliedCount: number;
};

const PROPOSAL_CREATED_KEY = /^[a-f0-9]{24}$/u;

function parseProposalManifestEntry(value: unknown): ProposalManifestEntry {
	if (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		'collision' in value
	) {
		const candidate = value as Record<string, unknown>;
		const keys = Object.keys(candidate).sort();
		const expected = ['address', 'collision', 'op', 'value'];
		if (
			keys.length !== expected.length ||
			keys.some((key, index) => key !== expected[index]) ||
			candidate.collision !== 'refuse' ||
			candidate.op !== 'replace'
		) {
			throw new Error('Proposal manifest creation entry is invalid');
		}
		const parsed = parseIntent(
			{
				address: candidate.address,
				op: candidate.op,
				value: candidate.value,
			},
			SCALAR_SYNC_V1_LIMITS,
		);
		if (parsed.error !== null || parsed.data.op !== 'replace') {
			throw new Error('Proposal manifest creation entry is inadmissible');
		}
		return { ...parsed.data, collision: 'refuse' };
	}
	const parsed = parseIntent(value, SCALAR_SYNC_V1_LIMITS);
	if (parsed.error !== null) {
		throw new Error('Proposal manifest entry is inadmissible');
	}
	return parsed.data;
}

type WriteProposalArtifactOptions = {
	database: SqliteDatabase;
	hmacKey: Uint8Array;
	proposalId: string;
	sourceReplicaId: string;
	sourceAuthorityLifetime: string | null;
	lens: LensDefinition;
	selection: ProposalSelection;
	records: Iterable<ProposalSourceRecord>;
};

type ProposalMetadataRow = {
	proposal_id: string;
	source_replica_id: string;
	source_authority_lifetime: string | null;
	lens_json: string;
	selection_json: string;
	draft_hmac: string;
	manifest_count: number;
	manifest_hmac: string | null;
};

type BaseRecordRow = {
	namespace: string;
	collection: string;
	record_key: string;
	state: 'live' | 'absent';
	payload_json: string | null;
};

type ManifestRow = { sequence: number; entry_json: string };
type WatermarkRow = { applied_count: number; watermark_hmac: string | null };
type SchemaObjectRow = {
	type: string;
	name: string;
	tbl_name: string;
	sql: string | null;
};
type TableColumnRow = { name: string };

const INTERNAL_SCHEMA = [
	`CREATE TABLE _epicenter_artifact (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		kind TEXT NOT NULL CHECK (kind = 'proposal'),
		format_version INTEGER NOT NULL CHECK (format_version = 1),
		proposal_id TEXT NOT NULL,
		source_replica_id TEXT NOT NULL,
		source_authority_lifetime TEXT,
		lens_json TEXT NOT NULL CHECK (json_valid(lens_json)),
		selection_json TEXT NOT NULL CHECK (json_valid(selection_json)),
		draft_hmac TEXT NOT NULL CHECK (
			length(draft_hmac) = 64 AND draft_hmac NOT GLOB '*[^a-f0-9]*'
		),
		manifest_count INTEGER NOT NULL DEFAULT 0 CHECK (manifest_count >= 0),
		manifest_hmac TEXT CHECK (
			manifest_hmac IS NULL OR
			(length(manifest_hmac) = 64 AND manifest_hmac NOT GLOB '*[^a-f0-9]*')
		)
	) STRICT, WITHOUT ROWID`,
	`CREATE TABLE _epicenter_proposal_base (
		namespace TEXT NOT NULL,
		collection TEXT NOT NULL,
		record_key TEXT NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('live', 'absent')),
		payload_json TEXT CHECK (
			(state = 'live' AND payload_json IS NOT NULL AND json_valid(payload_json)) OR
			(state = 'absent' AND payload_json IS NULL)
		),
		PRIMARY KEY (namespace, collection, record_key)
	) STRICT, WITHOUT ROWID`,
	`CREATE TABLE _epicenter_proposal_manifest (
		sequence INTEGER PRIMARY KEY CHECK (sequence >= 0),
		entry_json TEXT NOT NULL CHECK (json_valid(entry_json))
	) STRICT, WITHOUT ROWID`,
	`CREATE TABLE _epicenter_proposal_apply (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		applied_count INTEGER NOT NULL CHECK (applied_count >= 0),
		watermark_hmac TEXT CHECK (
			watermark_hmac IS NULL OR
			(length(watermark_hmac) = 64 AND watermark_hmac NOT GLOB '*[^a-f0-9]*')
		)
	) STRICT, WITHOUT ROWID`,
] as const;

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
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

function assertHmacKey(hmacKey: Uint8Array): void {
	if (hmacKey.length < 32) {
		throw new Error('Proposal HMAC key must contain at least 32 bytes');
	}
}

function sign(hmacKey: Uint8Array, value: JsonValue): string {
	return bytesToHex(hmac(sha256, hmacKey, utf8ToBytes(canonicalize(value))));
}

function signaturesEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) {
		difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return difference === 0;
}

function assertNonemptyText(value: string, label: string): void {
	if (value.length === 0 || !isWellFormedString(value)) {
		throw new Error(`${label} must be a nonempty well-formed string`);
	}
}

function validateIdentity(
	proposalId: string,
	sourceReplicaId: string,
	sourceAuthorityLifetime: string | null,
): void {
	if (!/^[a-z0-9]{24}$/u.test(proposalId)) {
		throw new Error('Proposal ID is invalid');
	}
	if (!/^[a-z0-9]{24}$/u.test(sourceReplicaId)) {
		throw new Error('Proposal source replica ID is invalid');
	}
	if (sourceAuthorityLifetime !== null) {
		assertNonemptyText(
			sourceAuthorityLifetime,
			'Proposal source authority lifetime',
		);
	}
}

function validateCollectionNames(lens: LensDefinition): void {
	const names = new Map<string, string>();
	for (const [collection, definition] of Object.entries(lens.collections)) {
		const folded = asciiFold(collection);
		if (folded.startsWith('_epicenter_') || folded.startsWith('sqlite_')) {
			throw new Error(`Proposal collection name '${collection}' is reserved`);
		}
		const previous = names.get(folded);
		if (previous !== undefined) {
			throw new Error(
				`Proposal collection names '${previous}' and '${collection}' collide in SQLite`,
			);
		}
		names.set(folded, collection);
		const columnNames =
			definition.kind === 'table'
				? ['id', ...Object.keys(definition.fields)]
				: ['singleton', ...Object.keys(definition.values)];
		const columns = new Map<string, string>();
		for (const column of columnNames) {
			const foldedColumn = asciiFold(column);
			const previousColumn = columns.get(foldedColumn);
			if (previousColumn !== undefined) {
				throw new Error(
					`Proposal collection '${collection}' columns '${previousColumn}' and '${column}' collide in SQLite`,
				);
			}
			columns.set(foldedColumn, column);
		}
	}
}

function validateSelection(
	lens: LensDefinition,
	selection: ProposalSelection,
): ProposalSelection {
	const selectionKeys = Object.keys(selection).sort();
	if (
		selectionKeys.length !== 2 ||
		selectionKeys[0] !== 'collections' ||
		selectionKeys[1] !== 'namespace'
	) {
		throw new Error('Proposal selection has an invalid shape');
	}
	if (selection.namespace !== lens.namespace) {
		throw new Error('Proposal selection namespace must match its Lens');
	}
	if (!isNamespaceKey(selection.namespace, SCALAR_SYNC_V1_LIMITS)) {
		throw new Error('Proposal selection namespace is invalid');
	}
	if (
		typeof selection.collections !== 'object' ||
		selection.collections === null ||
		Array.isArray(selection.collections)
	) {
		throw new Error('Proposal selection collections must be an object');
	}
	const normalized: ProposalSelection = {
		namespace: selection.namespace,
		collections: {},
	};
	for (const [collection, selected] of Object.entries(selection.collections)) {
		const definition = lens.collections[collection];
		if (definition === undefined) {
			throw new Error(
				`Proposal selection collection '${collection}' is not in its Lens`,
			);
		}
		if (
			typeof selected !== 'object' ||
			selected === null ||
			Array.isArray(selected)
		) {
			throw new Error(`Proposal selection '${collection}' is invalid`);
		}
		const actualKeys = Object.keys(selected).sort();
		const expectedKeys =
			definition.kind === 'table'
				? ['allowCreate', 'kind', 'recordKeys']
				: ['kind', 'recordKeys'];
		if (
			actualKeys.length !== expectedKeys.length ||
			actualKeys.some((key, index) => key !== expectedKeys[index])
		) {
			throw new Error(
				`Proposal selection '${collection}' has an invalid shape`,
			);
		}
		if (
			selected.kind !== definition.kind ||
			!Array.isArray(selected.recordKeys)
		) {
			throw new Error(`Proposal selection '${collection}' has an invalid kind`);
		}
		const recordKeys: string[] = [];
		for (const recordKey of selected.recordKeys) {
			if (
				typeof recordKey !== 'string' ||
				parseAddress(
					{ namespace: selection.namespace, collection, recordKey },
					SCALAR_SYNC_V1_LIMITS,
				).error !== null
			) {
				throw new Error(
					`Proposal selection '${collection}' has an invalid record key`,
				);
			}
			if (recordKeys.includes(recordKey)) {
				throw new Error(
					`Proposal selection '${collection}' repeats record '${recordKey}'`,
				);
			}
			if (
				definition.kind === 'values' &&
				!Object.hasOwn(definition.values, recordKey)
			) {
				throw new Error(
					`Proposal selection '${collection}' value '${recordKey}' is not in its Lens`,
				);
			}
			recordKeys.push(recordKey);
		}
		recordKeys.sort();
		if (selected.kind === 'table') {
			if (typeof selected.allowCreate !== 'boolean') {
				throw new Error(
					`Proposal selection '${collection}' allowCreate must be boolean`,
				);
			}
			if (recordKeys.length === 0 && !selected.allowCreate) {
				throw new Error(`Proposal selection '${collection}' is empty`);
			}
			normalized.collections[collection] = {
				kind: 'table',
				recordKeys,
				allowCreate: selected.allowCreate,
			};
		} else {
			if (recordKeys.length === 0) {
				throw new Error(`Proposal selection '${collection}' is empty`);
			}
			normalized.collections[collection] = { kind: 'values', recordKeys };
		}
	}
	if (Object.keys(normalized.collections).length === 0) {
		throw new Error('Proposal selection must contain at least one collection');
	}
	return normalized;
}

/** Parse one exact Lens-shaped Proposal selection at a trusted host boundary. */
export function parseProposalSelection(
	lens: LensDefinition,
	input: unknown,
): ProposalSelection {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		throw new Error('Proposal selection must be an object');
	}
	return validateSelection(lens, input as ProposalSelection);
}

function fieldSql(schema: TSchema, isRequired: boolean): string {
	const field = recognize(schema);
	if (field === null || field.kind === 'reference') {
		throw new Error('Proposal Lens contains an unsupported field');
	}
	const required = isRequired ? ' NOT NULL' : '';
	switch (field.kind) {
		case 'boolean':
			return `INTEGER${required} CHECK (VALUE IS NULL OR VALUE IN (0, 1))`;
		case 'integer':
			return `INTEGER${required}`;
		case 'number':
			return `REAL${required}`;
		case 'multiSelect':
		case 'tags':
			return `TEXT${required} CHECK (VALUE IS NULL OR (json_valid(VALUE) AND json_type(VALUE) = 'array'))`;
		case 'json':
			return `TEXT${required} CHECK (VALUE IS NULL OR json_valid(VALUE))`;
		case 'date':
		case 'datetime':
		case 'instant':
		case 'select':
		case 'string':
		case 'url':
			return `TEXT${required}`;
		default:
			return field satisfies never;
	}
}

function tableSql(
	collection: string,
	definition: Extract<LensDefinition['collections'][string], { kind: 'table' }>,
): string {
	const optional = new Set(definition.optional);
	const columns = Object.entries(definition.fields).map(([name, schema]) => {
		const sql = fieldSql(schema, !optional.has(name)).replaceAll(
			'VALUE',
			quoteIdentifier(name),
		);
		return `${quoteIdentifier(name)} ${sql}`;
	});
	return `CREATE TABLE ${quoteIdentifier(collection)} (
		id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(12))))${
			columns.length === 0 ? '' : `,\n\t\t${columns.join(',\n\t\t')}`
		}
	) STRICT, WITHOUT ROWID`;
}

function valuesSql(
	collection: string,
	definition: Extract<
		LensDefinition['collections'][string],
		{ kind: 'values' }
	>,
	selected: ValuesSelection,
): string {
	const columns = selected.recordKeys.map((recordKey) => {
		const schema = definition.values[recordKey];
		if (schema === undefined)
			throw new Error('Selected value schema is missing');
		return `${quoteIdentifier(recordKey)} ${fieldSql(schema, false).replaceAll(
			'VALUE',
			quoteIdentifier(recordKey),
		)}`;
	});
	return `CREATE TABLE ${quoteIdentifier(collection)} (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		${columns.join(',\n\t\t')}
	) STRICT, WITHOUT ROWID`;
}

function friendlySchema(
	lens: LensDefinition,
	selection: ProposalSelection,
): string[] {
	return Object.entries(selection.collections)
		.sort(([left], [right]) => compareText(left, right))
		.map(([collection, selected]) => {
			const definition = lens.collections[collection];
			if (definition === undefined || definition.kind !== selected.kind) {
				throw new Error('Proposal Lens and selection disagree');
			}
			return definition.kind === 'table'
				? tableSql(collection, definition)
				: valuesSql(collection, definition, selected as ValuesSelection);
		});
}

function sqliteValue(schema: TSchema, value: unknown): string | number {
	const field = recognize(schema);
	if (field === null || field.kind === 'reference') {
		throw new Error('Proposal Lens contains an unsupported field');
	}
	switch (field.kind) {
		case 'boolean':
			return value ? 1 : 0;
		case 'integer':
		case 'number':
			return value as number;
		case 'multiSelect':
		case 'tags':
		case 'json':
			return canonicalize(value as JsonValue);
		case 'date':
		case 'datetime':
		case 'instant':
		case 'select':
		case 'string':
		case 'url':
			return value as string;
		default:
			return field satisfies never;
	}
}

function jsonValue(schema: TSchema, value: unknown): unknown {
	if (value === null) return undefined;
	const field = recognize(schema);
	if (field === null || field.kind === 'reference') {
		throw new Error('Proposal Lens contains an unsupported field');
	}
	switch (field.kind) {
		case 'boolean':
			if (value !== 0 && value !== 1) throw new Error('Invalid boolean cell');
			return value === 1;
		case 'integer':
		case 'number':
		case 'date':
		case 'datetime':
		case 'instant':
		case 'select':
		case 'string':
		case 'url':
			return value;
		case 'multiSelect':
		case 'tags':
		case 'json':
			if (typeof value !== 'string') throw new Error('Invalid JSON cell');
			return JSON.parse(value) as unknown;
		default:
			return field satisfies never;
	}
}

function assertEmpty(database: SqliteDatabase): void {
	const objects = database.all<{ name: string }>(
		`SELECT name FROM sqlite_schema
		WHERE name NOT LIKE 'sqlite_%'`,
	);
	if (objects.length !== 0) {
		throw new Error('Proposal target database must be empty');
	}
}

function selectedAddresses(selection: ProposalSelection): string[] {
	const addresses: string[] = [];
	for (const [collection, selected] of Object.entries(selection.collections)) {
		for (const recordKey of selected.recordKeys) {
			addresses.push(
				`${selection.namespace}\u0000${collection}\u0000${recordKey}`,
			);
		}
	}
	return addresses.sort();
}

function sourceRows(
	lens: LensDefinition,
	selection: ProposalSelection,
	records: Iterable<ProposalSourceRecord>,
): ProposalSourceRecord[] {
	const expected = new Set(selectedAddresses(selection));
	const rows: ProposalSourceRecord[] = [];
	for (const record of records) {
		const key = `${record.address.namespace}\u0000${record.address.collection}\u0000${record.address.recordKey}`;
		if (!expected.delete(key)) {
			throw new Error(
				'Proposal source records do not exactly match the selection',
			);
		}
		const selected = selection.collections[record.address.collection];
		const definition = lens.collections[record.address.collection];
		if (selected === undefined || definition === undefined) {
			throw new Error('Proposal source record is outside its Lens');
		}
		if (definition.kind === 'table') {
			if (record.state !== 'live') {
				throw new Error('Selected Proposal table records must be live');
			}
			const projected = compileTableDefinition(definition, {
				namespace: lens.namespace,
				collection: record.address.collection,
			}).project(record.address.recordKey, record.payload);
			if (projected.error !== null) throw projected.error;
		} else if (record.state === 'live') {
			const schema = definition.values[record.address.recordKey];
			if (schema === undefined)
				throw new Error('Selected value is outside its Lens');
			const projected = compileValueDefinition(schema).project(
				record.payload,
				record.address,
			);
			if (projected.error !== null) throw projected.error;
		}
		rows.push(structuredClone(record));
	}
	if (expected.size !== 0) {
		throw new Error(
			'Proposal source records do not exactly match the selection',
		);
	}
	return rows.sort((left, right) =>
		compareText(canonicalize(left.address), canonicalize(right.address)),
	);
}

function insertFriendlyRows(
	database: SqliteDatabase,
	lens: LensDefinition,
	selection: ProposalSelection,
	records: readonly ProposalSourceRecord[],
): void {
	const byCollection = new Map<string, ProposalSourceRecord[]>();
	for (const record of records) {
		const group = byCollection.get(record.address.collection) ?? [];
		group.push(record);
		byCollection.set(record.address.collection, group);
	}
	for (const [collection, selected] of Object.entries(selection.collections)) {
		const definition = lens.collections[collection];
		if (definition === undefined)
			throw new Error('Selected collection is missing');
		const collectionRows = byCollection.get(collection) ?? [];
		if (definition.kind === 'table') {
			const compiled = compileTableDefinition(definition, {
				namespace: lens.namespace,
				collection,
			});
			for (const record of collectionRows) {
				if (record.state !== 'live') throw new Error('Table record is absent');
				const projected = compiled.project(
					record.address.recordKey,
					record.payload,
				);
				if (projected.error !== null) throw projected.error;
				const fields = Object.keys(definition.fields);
				database.run(
					`INSERT INTO ${quoteIdentifier(collection)} (
						id${fields.map((field) => `, ${quoteIdentifier(field)}`).join('')}
					) VALUES (?${fields.map(() => ', ?').join('')})`,
					[
						record.address.recordKey,
						...fields.map((field) => {
							const value = projected.data[field];
							return value === undefined
								? null
								: sqliteValue(definition.fields[field] as TSchema, value);
						}),
					],
				);
			}
		} else {
			const values = selected.recordKeys.map((recordKey) => {
				const record = collectionRows.find(
					(candidate) => candidate.address.recordKey === recordKey,
				);
				if (record === undefined || record.state === 'absent') return null;
				const schema = definition.values[recordKey];
				if (schema === undefined) throw new Error('Selected value is missing');
				return sqliteValue(schema, record.payload);
			});
			database.run(
				`INSERT INTO ${quoteIdentifier(collection)} (
					singleton${selected.recordKeys
						.map((recordKey) => `, ${quoteIdentifier(recordKey)}`)
						.join('')}
				) VALUES (1${selected.recordKeys.map(() => ', ?').join('')})`,
				values,
			);
		}
	}
}

function schemaObjects(database: SqliteDatabase): SchemaObjectRow[] {
	return database.all<SchemaObjectRow>(
		`SELECT type, name, tbl_name, sql FROM sqlite_schema
		WHERE name NOT LIKE 'sqlite_%'
		ORDER BY type, name`,
	);
}

function schemaFingerprint(database: SqliteDatabase): JsonValue {
	return schemaObjects(database).map((object) => ({
		type: object.type,
		name: object.name,
		table: object.tbl_name,
		sql: object.sql,
	}));
}

function baseRows(database: SqliteDatabase): BaseRecordRow[] {
	return database.all<BaseRecordRow>(
		`SELECT namespace, collection, record_key, state, payload_json
		FROM _epicenter_proposal_base
		ORDER BY namespace, collection, record_key`,
	);
}

function draftSealValue(
	database: SqliteDatabase,
	metadata: Omit<ProposalMetadataRow, 'draft_hmac'>,
): JsonValue {
	return {
		kind: 'proposal',
		formatVersion: PROPOSAL_ARTIFACT_FORMAT_VERSION,
		proposalId: metadata.proposal_id,
		sourceReplicaId: metadata.source_replica_id,
		sourceAuthorityLifetime: metadata.source_authority_lifetime,
		lens: JSON.parse(metadata.lens_json) as JsonValue,
		selection: JSON.parse(metadata.selection_json) as JsonValue,
		schema: schemaFingerprint(database),
		base: baseRows(database).map((row) => ({
			namespace: row.namespace,
			collection: row.collection,
			recordKey: row.record_key,
			state: row.state,
			payload:
				row.payload_json === null
					? null
					: (JSON.parse(row.payload_json) as JsonValue),
		})),
	};
}

function readMetadata(database: SqliteDatabase): ProposalMetadataRow {
	const rows = database.all<ProposalMetadataRow>(
		`SELECT proposal_id, source_replica_id, source_authority_lifetime,
			lens_json, selection_json, draft_hmac, manifest_count, manifest_hmac
		FROM _epicenter_artifact
		WHERE singleton = 1 AND kind = 'proposal' AND format_version = ?`,
		[PROPOSAL_ARTIFACT_FORMAT_VERSION],
	);
	if (rows.length !== 1) throw new Error('Proposal metadata is invalid');
	return rows[0] as ProposalMetadataRow;
}

function expectedColumns(
	lens: LensDefinition,
	selection: ProposalSelection,
): Map<string, string[]> {
	const columns = new Map<string, string[]>([
		[
			'_epicenter_artifact',
			[
				'singleton',
				'kind',
				'format_version',
				'proposal_id',
				'source_replica_id',
				'source_authority_lifetime',
				'lens_json',
				'selection_json',
				'draft_hmac',
				'manifest_count',
				'manifest_hmac',
			],
		],
		[
			'_epicenter_proposal_base',
			['namespace', 'collection', 'record_key', 'state', 'payload_json'],
		],
		['_epicenter_proposal_manifest', ['sequence', 'entry_json']],
		[
			'_epicenter_proposal_apply',
			['singleton', 'applied_count', 'watermark_hmac'],
		],
	]);
	for (const [collection, selected] of Object.entries(selection.collections)) {
		const definition = lens.collections[collection];
		if (definition === undefined || definition.kind !== selected.kind) {
			throw new Error('Proposal Lens and selection disagree');
		}
		columns.set(
			collection,
			definition.kind === 'table'
				? ['id', ...Object.keys(definition.fields)]
				: ['singleton', ...selected.recordKeys],
		);
	}
	return columns;
}

function assertExactSchema(
	database: SqliteDatabase,
	lens: LensDefinition,
	selection: ProposalSelection,
): void {
	const columns = expectedColumns(lens, selection);
	const objects = schemaObjects(database);
	if (
		objects.length !== columns.size ||
		objects.some(
			(object) => object.type !== 'table' || !columns.has(object.name),
		)
	) {
		throw new Error('Proposal artifact has an unexpected schema object');
	}
	for (const [table, names] of columns) {
		const actual = database
			.all<TableColumnRow>(`PRAGMA table_xinfo(${quoteIdentifier(table)})`)
			.map((column) => column.name)
			.sort();
		const expected = [...names].sort();
		if (
			actual.length !== expected.length ||
			actual.some((column, index) => column !== expected[index])
		) {
			throw new Error(`Proposal table '${table}' has unexpected columns`);
		}
	}
}

function readAndVerifyDraft(database: SqliteDatabase, hmacKey: Uint8Array) {
	assertHmacKey(hmacKey);
	const metadata = readMetadata(database);
	const parsedLens = parseLens(JSON.parse(metadata.lens_json));
	if (parsedLens.error !== null) throw parsedLens.error;
	const selection = validateSelection(
		parsedLens.data,
		JSON.parse(metadata.selection_json) as ProposalSelection,
	);
	assertExactSchema(database, parsedLens.data, selection);
	const { draft_hmac: draftHmac, ...unsigned } = metadata;
	const expected = sign(hmacKey, draftSealValue(database, unsigned));
	if (!signaturesEqual(draftHmac, expected)) {
		throw new Error('Proposal draft seal is invalid');
	}
	if (metadata.manifest_hmac === null) {
		const manifestRows = database.all<ManifestRow>(
			'SELECT sequence, entry_json FROM _epicenter_proposal_manifest',
		);
		const watermarkRows = database.all<WatermarkRow>(
			`SELECT applied_count, watermark_hmac
			FROM _epicenter_proposal_apply WHERE singleton = 1`,
		);
		const watermark = watermarkRows[0];
		if (
			metadata.manifest_count !== 0 ||
			manifestRows.length !== 0 ||
			watermarkRows.length !== 1 ||
			watermark?.applied_count !== 0 ||
			watermark.watermark_hmac !== null
		) {
			throw new Error('Proposal draft lifecycle state is invalid');
		}
	}
	return { metadata, lens: parsedLens.data, selection };
}

/** Create one sealed, editable Proposal artifact in an empty SQLite database. */
export function writeProposalArtifact({
	database,
	hmacKey,
	proposalId,
	sourceReplicaId,
	sourceAuthorityLifetime,
	lens,
	selection,
	records,
}: WriteProposalArtifactOptions): void {
	assertEmpty(database);
	assertHmacKey(hmacKey);
	validateIdentity(proposalId, sourceReplicaId, sourceAuthorityLifetime);
	const parsedLens = parseLens(lens);
	if (parsedLens.error !== null) throw parsedLens.error;
	validateCollectionNames(parsedLens.data);
	const selected = validateSelection(parsedLens.data, selection);
	const selectedRecords = sourceRows(parsedLens.data, selected, records);
	const lensJson = canonicalize(parsedLens.data as unknown as JsonValue);
	const selectionJson = canonicalize(selected as unknown as JsonValue);
	database.transaction(() => {
		for (const statement of INTERNAL_SCHEMA) database.run(statement);
		for (const statement of friendlySchema(parsedLens.data, selected)) {
			database.run(statement);
		}
		database.run(
			`INSERT INTO _epicenter_artifact (
				singleton, kind, format_version, proposal_id, source_replica_id,
				source_authority_lifetime, lens_json, selection_json, draft_hmac
			) VALUES (1, 'proposal', ?, ?, ?, ?, ?, ?, ?)`,
			[
				PROPOSAL_ARTIFACT_FORMAT_VERSION,
				proposalId,
				sourceReplicaId,
				sourceAuthorityLifetime,
				lensJson,
				selectionJson,
				'0'.repeat(64),
			],
		);
		database.run(
			`INSERT INTO _epicenter_proposal_apply (
				singleton, applied_count, watermark_hmac
			) VALUES (1, 0, NULL)`,
		);
		for (const record of selectedRecords) {
			database.run(
				`INSERT INTO _epicenter_proposal_base (
					namespace, collection, record_key, state, payload_json
				) VALUES (?, ?, ?, ?, ?)`,
				[
					record.address.namespace,
					record.address.collection,
					record.address.recordKey,
					record.state,
					record.state === 'live' ? canonicalize(record.payload) : null,
				],
			);
		}
		insertFriendlyRows(database, parsedLens.data, selected, selectedRecords);
		const metadata = readMetadata(database);
		const { draft_hmac: _draftHmac, ...unsigned } = metadata;
		database.run(
			`UPDATE _epicenter_artifact SET draft_hmac = ? WHERE singleton = 1`,
			[sign(hmacKey, draftSealValue(database, unsigned))],
		);
	});
}

function baseRecordMap(database: SqliteDatabase): Map<string, BaseRecordRow> {
	return new Map(
		baseRows(database).map((row) => [
			`${row.collection}\u0000${row.record_key}`,
			row,
		]),
	);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
	if (left === undefined || right === undefined) return left === right;
	return canonicalize(left as JsonValue) === canonicalize(right as JsonValue);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compileTableEntries(
	database: SqliteDatabase,
	lens: LensDefinition,
	collection: string,
	definition: Extract<LensDefinition['collections'][string], { kind: 'table' }>,
	selected: TableSelection,
	base: Map<string, BaseRecordRow>,
): ProposalManifestEntry[] {
	const compiled = compileTableDefinition(definition, {
		namespace: lens.namespace,
		collection,
	});
	const fields = Object.keys(definition.fields);
	const rows = database.all<SqliteRow>(
		`SELECT ${['id', ...fields].map(quoteIdentifier).join(', ')}
		FROM ${quoteIdentifier(collection)} ORDER BY id`,
	);
	const byId = new Map<string, SqliteRow>();
	for (const row of rows) {
		if (typeof row.id !== 'string')
			throw new Error('Proposal row ID is invalid');
		byId.set(row.id, row);
	}
	const entries: ProposalManifestEntry[] = [];
	for (const recordKey of selected.recordKeys) {
		const row = byId.get(recordKey);
		const address = { namespace: lens.namespace, collection, recordKey };
		const baseRow = base.get(`${collection}\u0000${recordKey}`);
		if (baseRow?.state !== 'live' || baseRow.payload_json === null) {
			throw new Error('Proposal table base record is invalid');
		}
		if (row === undefined) {
			entries.push({ address, op: 'tombstone' });
			continue;
		}
		byId.delete(recordKey);
		const currentInput: Record<string, unknown> = {};
		for (const field of fields) {
			currentInput[field] = jsonValue(
				definition.fields[field] as TSchema,
				row[field],
			);
		}
		const current = compiled.validateCreate(currentInput);
		const projected = compiled.project(
			recordKey,
			JSON.parse(baseRow.payload_json) as JsonValue,
		);
		if (projected.error !== null) throw projected.error;
		const update: Record<string, unknown> = {};
		for (const field of fields) {
			const before = projected.data[field];
			const after = current[field];
			if (!canonicalEqual(before, after)) update[field] = after;
		}
		const normalized = compiled.normalizeUpdate(update);
		if (
			Object.keys(normalized.set).length !== 0 ||
			normalized.unset.length !== 0
		) {
			entries.push({ address, op: 'patch', ...normalized });
		}
	}
	if (byId.size !== 0 && !selected.allowCreate) {
		throw new Error(`Proposal table '${collection}' does not allow creation`);
	}
	for (const [recordKey, row] of byId) {
		if (!PROPOSAL_CREATED_KEY.test(recordKey)) {
			throw new Error(`Proposal table '${collection}' has an invalid new ID`);
		}
		const input: Record<string, unknown> = {};
		for (const field of fields) {
			input[field] = jsonValue(definition.fields[field] as TSchema, row[field]);
		}
		entries.push({
			address: { namespace: lens.namespace, collection, recordKey },
			op: 'replace',
			value: compiled.validateCreate(input),
			collision: 'refuse',
		});
	}
	return entries;
}

function compileValueEntries(
	database: SqliteDatabase,
	lens: LensDefinition,
	collection: string,
	definition: Extract<
		LensDefinition['collections'][string],
		{ kind: 'values' }
	>,
	selected: ValuesSelection,
	base: Map<string, BaseRecordRow>,
): ProposalManifestEntry[] {
	const rows = database.all<SqliteRow>(
		`SELECT ${['singleton', ...selected.recordKeys]
			.map(quoteIdentifier)
			.join(', ')} FROM ${quoteIdentifier(collection)}`,
	);
	if (rows.length !== 1 || rows[0]?.singleton !== 1) {
		throw new Error(
			`Proposal values table '${collection}' must contain one row`,
		);
	}
	const row = rows[0];
	const entries: ProposalManifestEntry[] = [];
	for (const recordKey of selected.recordKeys) {
		const schema = definition.values[recordKey];
		const baseRow = base.get(`${collection}\u0000${recordKey}`);
		if (schema === undefined || baseRow === undefined) {
			throw new Error('Proposal value base record is invalid');
		}
		const value = jsonValue(schema, row[recordKey]);
		const before =
			baseRow.state === 'live' && baseRow.payload_json !== null
				? (JSON.parse(baseRow.payload_json) as JsonValue)
				: undefined;
		if (value === undefined) {
			if (before !== undefined) {
				entries.push({
					address: { namespace: lens.namespace, collection, recordKey },
					op: 'unset',
				});
			}
			continue;
		}
		const validated = compileValueDefinition(schema).validate(value);
		if (before === undefined || !canonicalEqual(before, validated)) {
			entries.push({
				address: { namespace: lens.namespace, collection, recordKey },
				op: 'replace',
				value: validated,
			});
		}
	}
	return entries;
}

function manifestSealValue(
	metadata: ProposalMetadataRow,
	entries: readonly ProposalManifestEntry[],
): JsonValue {
	return {
		proposalId: metadata.proposal_id,
		sourceReplicaId: metadata.source_replica_id,
		sourceAuthorityLifetime: metadata.source_authority_lifetime,
		entries: entries as unknown as JsonValue,
	};
}

function watermarkSealValue(
	metadata: ProposalMetadataRow,
	appliedCount: number,
): JsonValue {
	return {
		proposalId: metadata.proposal_id,
		manifestHmac: metadata.manifest_hmac,
		appliedCount,
	};
}

/** Compile current friendly-table edits into one sealed, ordered manifest. */
export function compileProposalArtifact({
	database,
	hmacKey,
}: {
	database: SqliteDatabase;
	hmacKey: Uint8Array;
}): ProposalManifest {
	return database.transaction(() => {
		const verified = readAndVerifyDraft(database, hmacKey);
		if (verified.metadata.manifest_hmac !== null) {
			throw new Error('Proposal manifest is already sealed');
		}
		const base = baseRecordMap(database);
		const entries: ProposalManifestEntry[] = [];
		for (const [collection, selected] of Object.entries(
			verified.selection.collections,
		).sort(([left], [right]) => compareText(left, right))) {
			const definition = verified.lens.collections[collection];
			if (definition === undefined || definition.kind !== selected.kind) {
				throw new Error('Proposal Lens and selection disagree');
			}
			entries.push(
				...(definition.kind === 'table'
					? compileTableEntries(
							database,
							verified.lens,
							collection,
							definition,
							selected as TableSelection,
							base,
						)
					: compileValueEntries(
							database,
							verified.lens,
							collection,
							definition,
							selected as ValuesSelection,
							base,
						)),
			);
		}
		entries.sort((left, right) =>
			compareText(canonicalize(left.address), canonicalize(right.address)),
		);
		const admittedEntries = entries.map(parseProposalManifestEntry);
		database.run('DELETE FROM _epicenter_proposal_manifest');
		for (const [sequence, entry] of admittedEntries.entries()) {
			database.run(
				`INSERT INTO _epicenter_proposal_manifest (sequence, entry_json)
				VALUES (?, ?)`,
				[sequence, canonicalize(entry as unknown as JsonValue)],
			);
		}
		const manifestHmac = sign(
			hmacKey,
			manifestSealValue(verified.metadata, admittedEntries),
		);
		database.run(
			`UPDATE _epicenter_artifact
			SET manifest_count = ?, manifest_hmac = ? WHERE singleton = 1`,
			[admittedEntries.length, manifestHmac],
		);
		const metadata = { ...verified.metadata, manifest_hmac: manifestHmac };
		database.run(
			`UPDATE _epicenter_proposal_apply
			SET applied_count = 0, watermark_hmac = ? WHERE singleton = 1`,
			[sign(hmacKey, watermarkSealValue(metadata, 0))],
		);
		return {
			proposalId: metadata.proposal_id,
			sourceReplicaId: metadata.source_replica_id,
			sourceAuthorityLifetime: metadata.source_authority_lifetime,
			entries: admittedEntries,
			appliedCount: 0,
		};
	});
}

function readVerifiedManifest(
	database: SqliteDatabase,
	hmacKey: Uint8Array,
): ProposalManifest {
	const verified = readAndVerifyDraft(database, hmacKey);
	const metadata = verified.metadata;
	if (metadata.manifest_hmac === null) {
		throw new Error('Proposal has not been compiled');
	}
	const rows = database.all<ManifestRow>(
		`SELECT sequence, entry_json FROM _epicenter_proposal_manifest
		ORDER BY sequence`,
	);
	if (
		rows.length !== metadata.manifest_count ||
		rows.some((row, index) => row.sequence !== index)
	) {
		throw new Error('Proposal manifest sequence is invalid');
	}
	const entries = rows.map((row) =>
		parseProposalManifestEntry(JSON.parse(row.entry_json)),
	);
	const expectedManifestHmac = sign(
		hmacKey,
		manifestSealValue(metadata, entries),
	);
	if (!signaturesEqual(metadata.manifest_hmac, expectedManifestHmac)) {
		throw new Error('Proposal manifest seal is invalid');
	}
	const watermarks = database.all<WatermarkRow>(
		`SELECT applied_count, watermark_hmac
		FROM _epicenter_proposal_apply WHERE singleton = 1`,
	);
	const watermark = watermarks[0];
	if (
		watermarks.length !== 1 ||
		watermark === undefined ||
		watermark.watermark_hmac === null ||
		watermark.applied_count > entries.length
	) {
		throw new Error('Proposal Apply watermark is invalid');
	}
	const expectedWatermarkHmac = sign(
		hmacKey,
		watermarkSealValue(metadata, watermark.applied_count),
	);
	if (!signaturesEqual(watermark.watermark_hmac, expectedWatermarkHmac)) {
		throw new Error('Proposal Apply watermark seal is invalid');
	}
	return {
		proposalId: metadata.proposal_id,
		sourceReplicaId: metadata.source_replica_id,
		sourceAuthorityLifetime: metadata.source_authority_lifetime,
		entries,
		appliedCount: watermark.applied_count,
	};
}

/** Read and authenticate a compiled Proposal manifest and its mutable watermark. */
export function readProposalManifest({
	database,
	hmacKey,
}: {
	database: SqliteDatabase;
	hmacKey: Uint8Array;
}): ProposalManifest {
	return database.readTransaction(() =>
		readVerifiedManifest(database, hmacKey),
	);
}

/** Read one authenticated artifact status without exposing its HMAC key. */
export function readProposalArtifactStatus({
	database,
	hmacKey,
}: {
	database: SqliteDatabase;
	hmacKey: Uint8Array;
}): ProposalArtifactStatus {
	return database.readTransaction(() => {
		const draft = readAndVerifyDraft(database, hmacKey);
		if (draft.metadata.manifest_hmac === null) {
			return {
				proposalId: draft.metadata.proposal_id,
				sourceReplicaId: draft.metadata.source_replica_id,
				sourceAuthorityLifetime: draft.metadata.source_authority_lifetime,
				state: 'draft',
				changeCount: 0,
				appliedCount: 0,
			};
		}
		const manifest = readVerifiedManifest(database, hmacKey);
		return {
			proposalId: manifest.proposalId,
			sourceReplicaId: manifest.sourceReplicaId,
			sourceAuthorityLifetime: manifest.sourceAuthorityLifetime,
			state: 'compiled',
			changeCount: manifest.entries.length,
			appliedCount: manifest.appliedCount,
		};
	});
}

/** Authenticate and advance the manifest watermark by exactly one entry. */
export function advanceProposalWatermark({
	database,
	hmacKey,
	fromAppliedCount,
}: {
	database: SqliteDatabase;
	hmacKey: Uint8Array;
	fromAppliedCount: number;
}): number {
	return database.transaction(() => {
		const manifest = readVerifiedManifest(database, hmacKey);
		if (manifest.appliedCount !== fromAppliedCount) {
			throw new Error('Proposal Apply watermark changed concurrently');
		}
		if (fromAppliedCount >= manifest.entries.length) {
			throw new Error('Proposal Apply watermark is already complete');
		}
		const metadata = readMetadata(database);
		const appliedCount = fromAppliedCount + 1;
		database.run(
			`UPDATE _epicenter_proposal_apply
			SET applied_count = ?, watermark_hmac = ? WHERE singleton = 1`,
			[appliedCount, sign(hmacKey, watermarkSealValue(metadata, appliedCount))],
		);
		return appliedCount;
	});
}
