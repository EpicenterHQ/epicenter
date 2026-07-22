import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import {
	DOCUMENT_BOUND,
	exceedsDocumentBound,
	measureDocumentState,
} from '@epicenter/sync/document-v3';
import * as Y from '@y/y';
import { isBlobDigest } from './blob-v1/index.js';
import {
	canonicalize,
	encodedFactBytes,
	type Fact,
	isJsonValue,
	type JsonValue,
	parseAddress,
	type RecordAddress,
	SCALAR_SYNC_V1_LIMITS,
} from './protocol/v1/index.js';

export const PORTABLE_ARTIFACT_FORMAT_VERSION = 1;
const PORTABLE_TABLES = ['_epicenter_artifact', '_epicenter_records'] as const;

export type PortableArtifactRecord = {
	address: RecordAddress;
	scalar: { state: 'live'; payload: JsonValue } | { state: 'unset' };
	documentUpdateV2: Uint8Array | null;
	blobSha256: string | null;
};

export type PortableArtifactIndexMetadata = {
	kind: 'portable';
	formatVersion: typeof PORTABLE_ARTIFACT_FORMAT_VERSION;
	recordCount: number;
};

export type PortableArtifactRecordPage = readonly PortableArtifactRecord[];

export type PortableArtifactIndexPage = {
	records: PortableArtifactRecordPage;
	nextAfter?: RecordAddress;
};

type PortableRow = SqliteRow & {
	namespace: string;
	collection: string;
	record_key: string;
	payload_json: string | null;
	document_update_v2: Uint8Array | ArrayBuffer | null;
	blob_sha256: string | null;
};

type TableColumn = SqliteRow & {
	name: string;
	type: string;
	notnull: number;
	pk: number;
	hidden: number;
};

const PORTABLE_PAGE_LIMIT = 16;
const PORTABLE_RESTORE_SEQUENCE = Number.MAX_SAFE_INTEGER;

const PORTABLE_SCHEMA = [
	`CREATE TABLE _epicenter_artifact (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		kind TEXT NOT NULL CHECK (kind = 'portable'),
		format_version INTEGER NOT NULL CHECK (format_version = 1)
	) STRICT`,
	`CREATE TABLE _epicenter_records (
		namespace TEXT NOT NULL,
		collection TEXT NOT NULL,
		record_key TEXT NOT NULL,
		payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
		document_update_v2 BLOB
			CHECK (document_update_v2 IS NULL OR length(document_update_v2) > 0),
		blob_sha256 TEXT,
		PRIMARY KEY (namespace, collection, record_key),
		CHECK (blob_sha256 IS NULL OR
			(length(blob_sha256) = 64 AND blob_sha256 NOT GLOB '*[^a-f0-9]*'))
	) STRICT, WITHOUT ROWID`,
] as const;

function copyBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
	return value instanceof Uint8Array
		? new Uint8Array(value)
		: new Uint8Array(value.slice(0));
}

function validateAddress(address: RecordAddress): RecordAddress {
	const parsed = parseAddress(address, SCALAR_SYNC_V1_LIMITS);
	if (parsed.error !== null) throw parsed.error;
	return parsed.data;
}

function validateScalar(
	address: RecordAddress,
	scalar: PortableArtifactRecord['scalar'],
): string | null {
	if (
		scalar.state === 'live' &&
		!isJsonValue(scalar.payload, SCALAR_SYNC_V1_LIMITS)
	) {
		throw new Error('Portable record has an invalid scalar payload');
	}
	const fact: Fact =
		scalar.state === 'unset'
			? { address, sequence: PORTABLE_RESTORE_SEQUENCE, state: 'unset' }
			: {
					address,
					sequence: PORTABLE_RESTORE_SEQUENCE,
					state: 'live',
					payload: scalar.payload,
				};
	if (encodedFactBytes(fact) > SCALAR_SYNC_V1_LIMITS.maxEncodedFactBytes) {
		throw new Error('Portable record scalar exceeds the fact byte bound');
	}
	return scalar.state === 'live' ? canonicalize(scalar.payload) : null;
}

function validateDocument(update: Uint8Array): Uint8Array {
	if (update.byteLength === 0) {
		throw new Error('Portable document update must not be empty');
	}
	if (update.byteLength > DOCUMENT_BOUND.stateBytes) {
		throw new Error('Portable document update exceeds the document byte bound');
	}
	const document = new Y.Doc({ gc: true });
	try {
		Y.applyUpdateV2(document, update);
		if (
			document.store.pendingStructs !== null ||
			document.store.pendingDs !== null
		) {
			throw new Error('Portable document update is not self-contained');
		}
		const compact = new Uint8Array(Y.encodeStateAsUpdateV2(document));
		if (exceedsDocumentBound(measureDocumentState(compact))) {
			throw new Error('Portable document exceeds the document bound');
		}
		return compact;
	} catch (cause) {
		throw new Error('Portable document update is invalid', { cause });
	} finally {
		document.destroy();
	}
}

function assertEmpty(database: SqliteDatabase): void {
	const objects = database.all<{ name: string }>(
		`SELECT name FROM sqlite_schema
		WHERE type IN ('table', 'view', 'index') AND name NOT LIKE 'sqlite_%'`,
	);
	if (objects.length !== 0) {
		throw new Error('Portable artifact target database must be empty');
	}
}

function assertPortableSchema(database: SqliteDatabase): void {
	const objects = database.all<SqliteRow & { name: string; type: string }>(
		`SELECT type, name FROM sqlite_schema
		WHERE type IN ('table', 'index', 'view', 'trigger')
			AND name NOT LIKE 'sqlite_%'
		ORDER BY type, name`,
	);
	if (
		objects.length !== PORTABLE_TABLES.length ||
		objects.some(
			(entry, index) =>
				entry.type !== 'table' || entry.name !== PORTABLE_TABLES[index],
		)
	) {
		throw new Error('Portable artifact schema is not recognized');
	}
	const expectedColumns = {
		_epicenter_artifact: [
			['singleton', 'INTEGER', 0, 1, 0],
			['kind', 'TEXT', 1, 0, 0],
			['format_version', 'INTEGER', 1, 0, 0],
		],
		_epicenter_records: [
			['namespace', 'TEXT', 1, 1, 0],
			['collection', 'TEXT', 1, 2, 0],
			['record_key', 'TEXT', 1, 3, 0],
			['payload_json', 'TEXT', 0, 0, 0],
			['document_update_v2', 'BLOB', 0, 0, 0],
			['blob_sha256', 'TEXT', 0, 0, 0],
		],
	} as const;
	for (const table of PORTABLE_TABLES) {
		const tableList = database.all<
			SqliteRow & { name: string; wr: number; strict: number }
		>(`PRAGMA table_list('${table}')`);
		if (
			tableList.length !== 1 ||
			tableList[0]?.name !== table ||
			tableList[0].strict !== 1 ||
			tableList[0].wr !== (table === '_epicenter_records' ? 1 : 0)
		) {
			throw new Error('Portable artifact table shape is not recognized');
		}
		const columns = database.all<TableColumn>(`PRAGMA table_xinfo('${table}')`);
		const expected = expectedColumns[table];
		if (
			columns.length !== expected.length ||
			columns.some((column, index) => {
				const shape = expected[index];
				return (
					shape === undefined ||
					column.name !== shape[0] ||
					column.type !== shape[1] ||
					column.notnull !== shape[2] ||
					column.pk !== shape[3] ||
					column.hidden !== shape[4]
				);
			})
		) {
			throw new Error('Portable artifact column shape is not recognized');
		}
	}
	const declaration = database.all<
		SqliteRow & { kind: string; format_version: number }
	>(`SELECT kind, format_version FROM _epicenter_artifact`);
	if (
		declaration.length !== 1 ||
		declaration[0]?.kind !== 'portable' ||
		declaration[0].format_version !== PORTABLE_ARTIFACT_FORMAT_VERSION
	) {
		throw new Error('Artifact is not a supported portable Epicenter');
	}
}

function assertCellBounds(database: SqliteDatabase): void {
	const maxima = database.all<
		SqliteRow & {
			namespace_bytes: number | null;
			collection_bytes: number | null;
			record_key_bytes: number | null;
			payload_bytes: number | null;
			document_bytes: number | null;
			blob_digest_bytes: number | null;
		}
	>(
		`SELECT
			max(length(CAST(namespace AS BLOB))) AS namespace_bytes,
			max(length(CAST(collection AS BLOB))) AS collection_bytes,
			max(length(CAST(record_key AS BLOB))) AS record_key_bytes,
			max(length(CAST(payload_json AS BLOB))) AS payload_bytes,
			max(length(document_update_v2)) AS document_bytes,
			max(length(CAST(blob_sha256 AS BLOB))) AS blob_digest_bytes
		FROM _epicenter_records`,
	)[0];
	if (
		maxima === undefined ||
		(maxima.namespace_bytes ?? 0) > SCALAR_SYNC_V1_LIMITS.maxNamespaceBytes ||
		(maxima.collection_bytes ?? 0) >
			SCALAR_SYNC_V1_LIMITS.maxCollectionKeyBytes ||
		(maxima.record_key_bytes ?? 0) > SCALAR_SYNC_V1_LIMITS.maxRecordKeyBytes ||
		(maxima.payload_bytes ?? 0) > SCALAR_SYNC_V1_LIMITS.maxEncodedFactBytes ||
		(maxima.document_bytes ?? 0) > DOCUMENT_BOUND.stateBytes ||
		(maxima.blob_digest_bytes ?? 0) > 64
	) {
		throw new Error('Portable artifact cell exceeds its resource bound');
	}
}

function assertIntegrity(database: SqliteDatabase): void {
	const integrity = database.all<{ integrity_check: string }>(
		'PRAGMA integrity_check',
	);
	if (
		integrity.length !== 1 ||
		integrity[0]?.integrity_check.toLowerCase() !== 'ok'
	) {
		throw new Error('Portable artifact failed SQLite integrity check');
	}
}

function recordFromRow(row: PortableRow): PortableArtifactRecord {
	const address = validateAddress({
		namespace: row.namespace,
		collection: row.collection,
		recordKey: row.record_key,
	});
	if (row.blob_sha256 !== null && !isBlobDigest(row.blob_sha256)) {
		throw new Error('Portable artifact contains an invalid blob digest');
	}
	const payload: unknown =
		row.payload_json === null ? undefined : JSON.parse(row.payload_json);
	if (
		payload !== undefined &&
		(!isJsonValue(payload, SCALAR_SYNC_V1_LIMITS) ||
			canonicalize(payload) !== row.payload_json)
	) {
		throw new Error('Portable artifact contains an invalid scalar payload');
	}
	const fact: Fact =
		payload === undefined
			? { address, sequence: PORTABLE_RESTORE_SEQUENCE, state: 'unset' }
			: {
					address,
					sequence: PORTABLE_RESTORE_SEQUENCE,
					state: 'live',
					payload,
				};
	if (encodedFactBytes(fact) > SCALAR_SYNC_V1_LIMITS.maxEncodedFactBytes) {
		throw new Error('Portable artifact scalar exceeds the fact byte bound');
	}
	return {
		address,
		scalar:
			row.payload_json === null
				? { state: 'unset' }
				: {
						state: 'live',
						payload: payload as JsonValue,
					},
		documentUpdateV2:
			row.document_update_v2 === null
				? null
				: validateDocument(copyBytes(row.document_update_v2)),
		blobSha256: row.blob_sha256,
	};
}

function createPortableArtifactSchema(database: SqliteDatabase): void {
	for (const statement of PORTABLE_SCHEMA) database.run(statement);
	database.run(
		`INSERT INTO _epicenter_artifact (singleton, kind, format_version)
		VALUES (1, 'portable', ?)`,
		[PORTABLE_ARTIFACT_FORMAT_VERSION],
	);
}

function insertPortableArtifactRecords(
	database: SqliteDatabase,
	records: Iterable<PortableArtifactRecord>,
): number {
	let recordCount = 0;
	for (const record of records) {
		const address = validateAddress(record.address);
		const payload = validateScalar(address, record.scalar);
		const document =
			record.documentUpdateV2 === null
				? null
				: validateDocument(record.documentUpdateV2);
		if (record.blobSha256 !== null && !isBlobDigest(record.blobSha256)) {
			throw new Error('Portable record has an invalid blob digest');
		}
		database.run(
			`INSERT INTO _epicenter_records (
				namespace, collection, record_key, payload_json,
				document_update_v2, blob_sha256
			) VALUES (?, ?, ?, ?, ?, ?)`,
			[
				address.namespace,
				address.collection,
				address.recordKey,
				payload,
				document,
				record.blobSha256,
			],
		);
		recordCount += 1;
	}
	return recordCount;
}

function portableArtifactMetadata(
	database: SqliteDatabase,
): PortableArtifactIndexMetadata {
	assertPortableSchema(database);
	assertCellBounds(database);
	assertIntegrity(database);
	const recordCount =
		database.all<{ count: number }>(
			'SELECT count(*) AS count FROM _epicenter_records',
		)[0]?.count ?? 0;
	return {
		kind: 'portable',
		formatVersion: PORTABLE_ARTIFACT_FORMAT_VERSION,
		recordCount,
	};
}

function validatePageLimit(limit: number): void {
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > PORTABLE_PAGE_LIMIT
	) {
		throw new RangeError(
			`Portable artifact page limit must be 1..${PORTABLE_PAGE_LIMIT}`,
		);
	}
}

function readPortableArtifactPage(
	database: SqliteDatabase,
	after: RecordAddress | undefined,
	limit: number,
): PortableArtifactIndexPage {
	const where =
		after === undefined
			? ''
			: 'WHERE (namespace, collection, record_key) > (?, ?, ?)';
	const parameters =
		after === undefined
			? [limit]
			: [after.namespace, after.collection, after.recordKey, limit];
	const rows = database.all<PortableRow>(
		`SELECT namespace, collection, record_key, payload_json,
			document_update_v2, blob_sha256
		FROM _epicenter_records ${where}
		ORDER BY namespace, collection, record_key LIMIT ?`,
		parameters,
	);
	const records = rows.map(recordFromRow);
	const last = records.at(-1);
	return {
		records,
		...(rows.length === limit && last !== undefined
			? { nextAfter: structuredClone(last.address) }
			: {}),
	};
}

/**
 * Initialize disposable scratch storage for bounded portable-index writes.
 *
 * The caller must keep the database unpublished until a complete scan passes.
 * An interrupted or uncertain build is discarded wholesale, never resumed.
 */
export function initializePortableArtifactScratchIndex(
	database: SqliteDatabase,
): void {
	assertEmpty(database);
	database.transaction(() => createPortableArtifactSchema(database));
}

/** Append one atomic page to unpublished portable-index scratch storage. */
export function appendPortableArtifactScratchRecords({
	database,
	records,
}: {
	database: SqliteDatabase;
	records: Iterable<PortableArtifactRecord>;
}): number {
	return database.transaction(() => {
		assertPortableSchema(database);
		return insertPortableArtifactRecords(database, records);
	});
}

/** Read and validate one bounded page from a structurally portable index. */
export function readPortableArtifactIndexPage({
	database,
	after,
	limit = PORTABLE_PAGE_LIMIT,
}: {
	database: SqliteDatabase;
	after?: RecordAddress;
	limit?: number;
}): PortableArtifactIndexPage {
	validatePageLimit(limit);
	const cursor = after === undefined ? undefined : validateAddress(after);
	return database.readTransaction(() => {
		assertPortableSchema(database);
		return readPortableArtifactPage(database, cursor, limit);
	});
}

/** Write the identity-free SQLite index for one portable Epicenter. */
export function writePortableArtifactIndex({
	database,
	records,
}: {
	database: SqliteDatabase;
	records: Iterable<PortableArtifactRecord>;
}): PortableArtifactIndexMetadata {
	assertEmpty(database);
	return database.transaction(() => {
		createPortableArtifactSchema(database);
		insertPortableArtifactRecords(database, records);
		return portableArtifactMetadata(database);
	});
}

/**
 * Validate and scan the SQLite index inside one portable Epicenter.
 *
 * This does not validate the container's blob entries. The container owner must
 * verify every referenced digest and reject missing, corrupt, or extra files
 * before treating the complete artifact as restorable.
 */
export function scanPortableArtifactIndex({
	database,
	onPage,
}: {
	database: SqliteDatabase;
	onPage(page: PortableArtifactRecordPage): void;
}): PortableArtifactIndexMetadata {
	return database.readTransaction(() => {
		const metadata = portableArtifactMetadata(database);
		const recordCount = metadata.recordCount;
		let cursor: RecordAddress | undefined;
		let seen = 0;
		for (;;) {
			const page = readPortableArtifactPage(
				database,
				cursor,
				PORTABLE_PAGE_LIMIT,
			);
			if (page.records.length === 0) break;
			seen += page.records.length;
			onPage(page.records);
			if (page.nextAfter === undefined) break;
			cursor = page.nextAfter;
		}
		if (seen !== recordCount) {
			throw new Error('Portable artifact record scan is incomplete');
		}
		return metadata;
	});
}
