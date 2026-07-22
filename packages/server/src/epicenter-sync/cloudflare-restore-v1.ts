import type { PortableArtifactRecord } from '@epicenter/data/portable';
import { canonicalize } from '@epicenter/data/protocol/v1';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';

import {
	AUTHORITY_V1_FORMAT_VERSION,
	AUTHORITY_V1_INDEXES,
	AUTHORITY_V1_TABLES,
	authorityV1CoreSchemaStatements,
	createAuthorityV1OperationalState,
	openAuthorityV1Schema,
} from './authority-v1-schema.js';

const MAX_PAGE = 16;
const BUILDING_FORMAT_VERSION = 0;

const RESTORE_TABLES = {
	meta: '_epicenter_restore_v1_meta',
	records: '_epicenter_restore_v1_records',
	recordDocuments: '_epicenter_restore_v1_record_documents',
} as const;

const RESTORE_TABLE_NAMES = [
	RESTORE_TABLES.meta,
	RESTORE_TABLES.records,
	RESTORE_TABLES.recordDocuments,
] as const;

const CANONICAL_DROP_ORDER = [
	'capture_manifest_records',
	'capture_manifests',
	'replica_witness',
	'record_documents',
	'records',
	'meta',
] as const;

type RestoreMeta = SqliteRow & {
	format_version: number;
	authority_lifetime: string;
	next_sequence: number;
	next_capture_revision: number;
};

type RestoreSummary = SqliteRow & {
	record_count: number;
	minimum_record_id: number | null;
	maximum_record_id: number | null;
	minimum_sequence: number | null;
	maximum_sequence: number | null;
	minimum_capture_revision: number | null;
	maximum_capture_revision: number | null;
	mismatched_position_count: number;
	invalid_state_count: number;
	document_count: number;
	invalid_document_count: number;
	orphan_document_count: number;
};

export type CloudflareRestoreV1Construction = {
	outgoingAuthorityLifetime: string;
	successorAuthorityLifetime: string;
};

export type CloudflareRestoreV1Seal = {
	authorityLifetime: string;
	recordCount: number;
};

function restoreMeta(database: SqliteDatabase): RestoreMeta {
	const rows = database.all<RestoreMeta>(
		`SELECT format_version, authority_lifetime, next_sequence,
			next_capture_revision
		FROM "${RESTORE_TABLES.meta}" WHERE singleton = 1`,
	);
	if (rows.length !== 1) {
		throw new Error('Cloudflare Restore staging metadata is not recognized');
	}
	return rows[0] as RestoreMeta;
}

function assertExpectedObjects(database: SqliteDatabase): void {
	const actual = database
		.all<SqliteRow & { name: string; type: string }>(
			`SELECT type, name FROM sqlite_schema
			WHERE type IN ('table', 'index', 'view', 'trigger')
				AND name NOT LIKE 'sqlite_%'
			ORDER BY type, name`,
		)
		.map(({ type, name }) => `${type}:${name}`);
	const expected = [
		...AUTHORITY_V1_INDEXES.map((name) => `index:${name}`),
		...AUTHORITY_V1_TABLES.map((name) => `table:${name}`),
		...RESTORE_TABLE_NAMES.map((name) => `table:${name}`),
	].sort();
	if (
		actual.length !== expected.length ||
		actual.some((entry, index) => entry !== expected[index])
	) {
		throw new Error('Cloudflare Restore staging schema is not recognized');
	}
}

function assertLifetime(value: string, label: string): void {
	if (value.length === 0) {
		throw new TypeError(`${label} authority lifetime must not be empty`);
	}
}

function assertRecordCount(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(
			'Cloudflare Restore record count must be a non-negative safe integer',
		);
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
		throw new Error('Cloudflare Restore staging failed SQLite integrity check');
	}
}

function validateConstruction(
	database: SqliteDatabase,
	expectedRecordCount: number,
): CloudflareRestoreV1Seal {
	assertExpectedObjects(database);
	const meta = restoreMeta(database);
	if (
		meta.format_version !== BUILDING_FORMAT_VERSION &&
		meta.format_version !== AUTHORITY_V1_FORMAT_VERSION
	) {
		throw new Error('Cloudflare Restore staging format is not recognized');
	}
	const summary = database.all<RestoreSummary>(
		`SELECT
			(SELECT count(*) FROM "${RESTORE_TABLES.records}") AS record_count,
			(SELECT min(record_id) FROM "${RESTORE_TABLES.records}")
				AS minimum_record_id,
			(SELECT max(record_id) FROM "${RESTORE_TABLES.records}")
				AS maximum_record_id,
			(SELECT min(sequence) FROM "${RESTORE_TABLES.records}")
				AS minimum_sequence,
			(SELECT max(sequence) FROM "${RESTORE_TABLES.records}")
				AS maximum_sequence,
			(SELECT min(capture_revision) FROM "${RESTORE_TABLES.records}")
				AS minimum_capture_revision,
			(SELECT max(capture_revision) FROM "${RESTORE_TABLES.records}")
				AS maximum_capture_revision,
			(SELECT count(*) FROM "${RESTORE_TABLES.records}"
				WHERE record_id != sequence OR sequence != capture_revision)
				AS mismatched_position_count,
			(SELECT count(*) FROM "${RESTORE_TABLES.records}"
				WHERE state NOT IN ('live', 'unset')) AS invalid_state_count,
			(SELECT count(*) FROM "${RESTORE_TABLES.recordDocuments}")
				AS document_count,
			(SELECT count(*) FROM "${RESTORE_TABLES.recordDocuments}"
				WHERE seq != 1 OR kind != 'baseline') AS invalid_document_count,
			(SELECT count(*) FROM "${RESTORE_TABLES.recordDocuments}" AS document
				LEFT JOIN "${RESTORE_TABLES.records}" AS record
					ON record.record_id = document.record_id
				WHERE record.record_id IS NULL) AS orphan_document_count`,
	)[0];
	const empty = expectedRecordCount === 0;
	if (
		summary === undefined ||
		summary.record_count !== expectedRecordCount ||
		meta.next_sequence !== expectedRecordCount + 1 ||
		meta.next_capture_revision !== expectedRecordCount + 1 ||
		(empty
			? summary.minimum_record_id !== null ||
				summary.maximum_record_id !== null ||
				summary.minimum_sequence !== null ||
				summary.maximum_sequence !== null ||
				summary.minimum_capture_revision !== null ||
				summary.maximum_capture_revision !== null
			: summary.minimum_record_id !== 1 ||
				summary.maximum_record_id !== expectedRecordCount ||
				summary.minimum_sequence !== 1 ||
				summary.maximum_sequence !== expectedRecordCount ||
				summary.minimum_capture_revision !== 1 ||
				summary.maximum_capture_revision !== expectedRecordCount) ||
		summary.mismatched_position_count !== 0 ||
		summary.invalid_state_count !== 0 ||
		summary.invalid_document_count !== 0 ||
		summary.orphan_document_count !== 0 ||
		summary.document_count > expectedRecordCount
	) {
		throw new Error('Cloudflare Restore staging membership is incomplete');
	}
	assertIntegrity(database);
	return {
		authorityLifetime: meta.authority_lifetime,
		recordCount: summary.record_count,
	};
}

function dropRestoreTables(database: SqliteDatabase): void {
	const unknownDependents = database.all<
		SqliteRow & { type: string; name: string }
	>(
		`SELECT type, name FROM sqlite_schema
		WHERE type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%'
			AND tbl_name IN (?, ?, ?)
		ORDER BY type, name`,
		RESTORE_TABLE_NAMES,
	);
	if (unknownDependents.length !== 0) {
		throw new Error(
			'Cloudflare Restore staging has unknown attached schema objects',
		);
	}
	database.run(`DROP TABLE IF EXISTS "${RESTORE_TABLES.recordDocuments}"`);
	database.run(`DROP TABLE IF EXISTS "${RESTORE_TABLES.records}"`);
	database.run(`DROP TABLE IF EXISTS "${RESTORE_TABLES.meta}"`);
}

/**
 * Drop only the fixed, unpublished Restore tables after a constructor restart.
 * Unknown objects remain so the strict canonical opener can fail closed.
 */
export function recoverCloudflareRestoreV1(database: SqliteDatabase): void {
	database.transaction(() => dropRestoreTables(database));
}

/** Discard one incomplete or sealed, but not activated, construction. */
export function abandonCloudflareRestoreV1(database: SqliteDatabase): void {
	recoverCloudflareRestoreV1(database);
}

/** Create one inactive fresh-lifetime authority core beside the live authority. */
export function initializeCloudflareRestoreV1({
	database,
	successorAuthorityLifetime,
}: {
	database: SqliteDatabase;
	successorAuthorityLifetime: string;
}): CloudflareRestoreV1Construction {
	assertLifetime(successorAuthorityLifetime, 'successor');
	return database.transaction(() => {
		for (const table of RESTORE_TABLE_NAMES) {
			const found = database.all<{ name: string }>(
				`SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?`,
				[table],
			);
			if (found.length !== 0) {
				throw new Error('Cloudflare Restore staging already exists');
			}
		}
		openAuthorityV1Schema(database, undefined);
		const current = database.all<{ authority_lifetime: string }>(
			'SELECT authority_lifetime FROM meta WHERE singleton = 1',
		)[0];
		if (current === undefined) {
			throw new Error('canonical authority metadata is missing');
		}
		if (current.authority_lifetime === successorAuthorityLifetime) {
			throw new Error('Cloudflare Restore successor lifetime must be fresh');
		}
		for (const statement of authorityV1CoreSchemaStatements(RESTORE_TABLES)) {
			database.run(statement);
		}
		database.run(
			`INSERT INTO "${RESTORE_TABLES.meta}" (
				singleton, format_version, authority_lifetime, next_sequence,
				next_capture_revision
			) VALUES (1, ?, ?, 1, 1)`,
			[BUILDING_FORMAT_VERSION, successorAuthorityLifetime],
		);
		return {
			outgoingAuthorityLifetime: current.authority_lifetime,
			successorAuthorityLifetime,
		};
	});
}

/** Append one bounded, already validated portable record page atomically. */
export function appendCloudflareRestoreV1Page({
	database,
	records,
}: {
	database: SqliteDatabase;
	records: readonly PortableArtifactRecord[];
}): number {
	if (records.length === 0 || records.length > MAX_PAGE) {
		throw new RangeError(
			`Cloudflare Restore record page must contain 1..${MAX_PAGE} rows`,
		);
	}
	return database.transaction(() => {
		const meta = restoreMeta(database);
		if (meta.format_version !== BUILDING_FORMAT_VERSION) {
			throw new Error('Cloudflare Restore staging is not building');
		}
		let nextSequence = meta.next_sequence;
		for (const record of records) {
			const recordId = nextSequence;
			database.run(
				`INSERT INTO "${RESTORE_TABLES.records}" (
					record_id, namespace, collection, record_key, state, payload,
					sequence, capture_revision, accepted_blob_sha256
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					recordId,
					record.address.namespace,
					record.address.collection,
					record.address.recordKey,
					record.scalar.state,
					record.scalar.state === 'live'
						? canonicalize(record.scalar.payload)
						: null,
					nextSequence,
					nextSequence,
					record.blobSha256,
				],
			);
			if (record.documentUpdateV2 !== null) {
				database.run(
					`INSERT INTO "${RESTORE_TABLES.recordDocuments}" (
						record_id, seq, kind, bytes
					) VALUES (?, 1, 'baseline', ?)`,
					[recordId, record.documentUpdateV2],
				);
			}
			nextSequence += 1;
		}
		database.run(
			`UPDATE "${RESTORE_TABLES.meta}"
			SET next_sequence = ?, next_capture_revision = ?
			WHERE singleton = 1`,
			[nextSequence, nextSequence],
		);
		return records.length;
	});
}

/** Validate exact membership and durably mark this construction activatable. */
export function sealCloudflareRestoreV1({
	database,
	expectedRecordCount,
}: {
	database: SqliteDatabase;
	expectedRecordCount: number;
}): CloudflareRestoreV1Seal {
	assertRecordCount(expectedRecordCount);
	return database.transaction(() => {
		const sealed = validateConstruction(database, expectedRecordCount);
		const meta = restoreMeta(database);
		if (meta.format_version === BUILDING_FORMAT_VERSION) {
			database.run(
				`UPDATE "${RESTORE_TABLES.meta}" SET format_version = ?
				WHERE singleton = 1`,
				[AUTHORITY_V1_FORMAT_VERSION],
			);
		}
		return sealed;
	});
}

/**
 * Atomically replace the canonical authority with a previously sealed core.
 * Every high-cardinality index already belongs to the renamed staging table.
 */
export function activateCloudflareRestoreV1({
	database,
	outgoingAuthorityLifetime,
}: {
	database: SqliteDatabase;
	outgoingAuthorityLifetime: string;
}): CloudflareRestoreV1Seal {
	assertLifetime(outgoingAuthorityLifetime, 'outgoing');
	return database.transaction(() => {
		assertExpectedObjects(database);
		const staged = restoreMeta(database);
		if (staged.format_version !== AUTHORITY_V1_FORMAT_VERSION) {
			throw new Error('Cloudflare Restore staging is not sealed');
		}
		const current = database.all<{ authority_lifetime: string }>(
			'SELECT authority_lifetime FROM meta WHERE singleton = 1',
		)[0];
		if (current?.authority_lifetime !== outgoingAuthorityLifetime) {
			throw new Error('Cloudflare Restore outgoing lifetime is stale');
		}
		if (staged.authority_lifetime === outgoingAuthorityLifetime) {
			throw new Error('Cloudflare Restore successor lifetime is not fresh');
		}

		for (const table of CANONICAL_DROP_ORDER) {
			database.run(`DROP TABLE "${table}"`);
		}
		database.run(`ALTER TABLE "${RESTORE_TABLES.meta}" RENAME TO meta`);
		database.run(`ALTER TABLE "${RESTORE_TABLES.records}" RENAME TO records`);
		database.run(
			`ALTER TABLE "${RESTORE_TABLES.recordDocuments}"
			RENAME TO record_documents`,
		);
		createAuthorityV1OperationalState(database);
		openAuthorityV1Schema(database, undefined);
		return {
			authorityLifetime: staged.authority_lifetime,
			recordCount: staged.next_sequence - 1,
		};
	});
}
