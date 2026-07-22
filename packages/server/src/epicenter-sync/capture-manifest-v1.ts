import type { PortableArtifactRecord } from '@epicenter/data/portable';
import type { JsonValue, RecordAddress } from '@epicenter/data/protocol/v1';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';

import { captureAuthorityDocument } from './document-authority-v1.js';

const CAPTURE_ID = /^[a-z0-9]{24}$/;
// A page can materialize one 1 MiB compact document per row. Keep each
// authority transaction comfortably below the smallest supported heap.
const MAX_PAGE = 16;

type ManifestRow = SqliteRow & {
	capture_id: string;
	state: CaptureManifestState;
	after_capture_revision: number;
	sealed_capture_revision: number | null;
};

type SourceRecordRow = SqliteRow & {
	record_id: number;
	namespace: string;
	collection: string;
	record_key: string;
	state: 'live' | 'tombstone' | 'unset';
	payload: string | null;
	capture_revision: number;
	accepted_blob_sha256: string | null;
};

type CapturedRecordRow = SqliteRow & {
	record_id: number;
	namespace: string;
	collection: string;
	record_key: string;
	state: 'live' | 'unset';
	payload: string | null;
	document_update_v2: Uint8Array | ArrayBuffer | null;
	blob_sha256: string | null;
};

export type CaptureManifestState =
	| 'building'
	| 'sealed'
	| 'succeeded'
	| 'cancelled'
	| 'crashed';

export type CaptureProgress =
	| {
			kind: 'advanced';
			afterCaptureRevision: number;
			targetCaptureRevision: number;
			processedRecords: number;
			caughtUp: boolean;
	  }
	| { kind: 'document-not-settled'; address: RecordAddress };

export type CaptureSeal =
	| {
			kind: 'sealed';
			captureRevision: number;
			recordCount: number;
	  }
	| { kind: 'catch-up-required'; residueRecords: number }
	| { kind: 'document-not-settled'; address: RecordAddress };

class DocumentNotSettledError extends Error {
	constructor(readonly address: RecordAddress) {
		super('authority document is not settled for portable capture');
	}
}

function one<TRow extends SqliteRow>(
	database: SqliteDatabase,
	sql: string,
	parameters: readonly (string | number | null)[] = [],
): TRow | null {
	return database.all<TRow>(sql, parameters)[0] ?? null;
}

function validateCaptureId(captureId: string): void {
	if (!CAPTURE_ID.test(captureId)) {
		throw new TypeError(
			'capture ID must be 24 lowercase alphanumeric characters',
		);
	}
}

function validateLimit(limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) {
		throw new RangeError(`capture page limit must be 1..${MAX_PAGE}`);
	}
}

function manifest(database: SqliteDatabase, captureId: string): ManifestRow {
	const row = one<ManifestRow>(
		database,
		'SELECT * FROM capture_manifests WHERE capture_id = ?',
		[captureId],
	);
	if (row === null) throw new Error('capture manifest does not exist');
	return row;
}

function activeCaptureRevision(database: SqliteDatabase): number {
	const row = one<SqliteRow & { next_capture_revision: number }>(
		database,
		'SELECT next_capture_revision FROM meta WHERE singleton = 1',
	);
	if (row === null) throw new Error('authority metadata is missing');
	return row.next_capture_revision - 1;
}

function sourceRows(
	database: SqliteDatabase,
	after: number,
	through: number,
	limit: number,
): SourceRecordRow[] {
	return database.all<SourceRecordRow>(
		`SELECT record_id, namespace, collection, record_key, state, payload,
			capture_revision, accepted_blob_sha256
		FROM records
		WHERE capture_revision > ? AND capture_revision <= ?
		ORDER BY capture_revision LIMIT ?`,
		[after, through, limit],
	);
}

function addressOf(row: SourceRecordRow): RecordAddress {
	return {
		namespace: row.namespace,
		collection: row.collection,
		recordKey: row.record_key,
	};
}

function captureRows(
	database: SqliteDatabase,
	captureId: string,
	rows: readonly SourceRecordRow[],
): void {
	for (const row of rows) {
		if (row.state === 'tombstone') {
			database.run(
				'DELETE FROM capture_manifest_records WHERE capture_id = ? AND record_id = ?',
				[captureId, row.record_id],
			);
			continue;
		}
		const document = captureAuthorityDocument(database, row.record_id);
		if (document.kind === 'not-settled') {
			throw new DocumentNotSettledError(addressOf(row));
		}
		database.run(
			`INSERT INTO capture_manifest_records (
				capture_id, record_id, capture_revision, namespace, collection,
				record_key, state, payload, document_update_v2, blob_sha256
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (capture_id, record_id) DO UPDATE SET
				capture_revision = excluded.capture_revision,
				namespace = excluded.namespace,
				collection = excluded.collection,
				record_key = excluded.record_key,
				state = excluded.state,
				payload = excluded.payload,
				document_update_v2 = excluded.document_update_v2,
				blob_sha256 = excluded.blob_sha256`,
			[
				captureId,
				row.record_id,
				row.capture_revision,
				row.namespace,
				row.collection,
				row.record_key,
				row.state,
				row.payload,
				document.update,
				row.accepted_blob_sha256,
			],
		);
	}
}

function copyBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
	return value instanceof Uint8Array
		? new Uint8Array(value)
		: new Uint8Array(value.slice(0));
}

/** Durable authority-side selection and pin owner for one portable capture. */
export function createAuthorityCaptureManifestV1(database: SqliteDatabase) {
	function start(captureId: string): void {
		validateCaptureId(captureId);
		database.transaction(() => {
			database.run(
				`INSERT INTO capture_manifests (
					capture_id, state, after_capture_revision, sealed_capture_revision
				) VALUES (?, 'building', 0, NULL)`,
				[captureId],
			);
		});
	}

	function advance(captureId: string, limit = MAX_PAGE): CaptureProgress {
		validateCaptureId(captureId);
		validateLimit(limit);
		try {
			return database.transaction(() => {
				const current = manifest(database, captureId);
				if (current.state !== 'building') {
					throw new Error('only a building capture can advance');
				}
				const target = activeCaptureRevision(database);
				const rows = sourceRows(
					database,
					current.after_capture_revision,
					target,
					limit,
				);
				captureRows(database, captureId, rows);
				const after = rows.at(-1)?.capture_revision ?? target;
				database.run(
					`UPDATE capture_manifests SET after_capture_revision = ?
					WHERE capture_id = ?`,
					[after, captureId],
				);
				return {
					kind: 'advanced',
					afterCaptureRevision: after,
					targetCaptureRevision: target,
					processedRecords: rows.length,
					caughtUp: rows.length < limit,
				};
			});
		} catch (cause) {
			if (cause instanceof DocumentNotSettledError) {
				return { kind: 'document-not-settled', address: cause.address };
			}
			throw cause;
		}
	}

	function seal(captureId: string, closeLimit = 8): CaptureSeal {
		validateCaptureId(captureId);
		validateLimit(closeLimit);
		try {
			return database.transaction(() => {
				const current = manifest(database, captureId);
				if (current.state !== 'building') {
					throw new Error('only a building capture can seal');
				}
				const target = activeCaptureRevision(database);
				const residue = sourceRows(
					database,
					current.after_capture_revision,
					target,
					closeLimit + 1,
				);
				if (residue.length > closeLimit) {
					return {
						kind: 'catch-up-required',
						residueRecords: residue.length,
					};
				}
				captureRows(database, captureId, residue);
				database.run(
					`UPDATE capture_manifests SET state = 'sealed',
						after_capture_revision = ?, sealed_capture_revision = ?
					WHERE capture_id = ?`,
					[target, target, captureId],
				);
				const count = one<SqliteRow & { count: number }>(
					database,
					`SELECT count(*) AS count FROM capture_manifest_records
					WHERE capture_id = ?`,
					[captureId],
				)?.count;
				return {
					kind: 'sealed',
					captureRevision: target,
					recordCount: count ?? 0,
				};
			});
		} catch (cause) {
			if (cause instanceof DocumentNotSettledError) {
				return { kind: 'document-not-settled', address: cause.address };
			}
			throw cause;
		}
	}

	function readPage(
		captureId: string,
		afterRecordId = 0,
		limit = MAX_PAGE,
	): { entries: PortableArtifactRecord[]; nextAfterRecordId?: number } {
		validateCaptureId(captureId);
		validateLimit(limit);
		return database.readTransaction(() => {
			const current = manifest(database, captureId);
			if (current.state !== 'sealed') {
				throw new Error('only a sealed capture can be copied');
			}
			const rows = database.all<CapturedRecordRow>(
				`SELECT record_id, namespace, collection, record_key, state, payload,
					document_update_v2, blob_sha256
				FROM capture_manifest_records
				WHERE capture_id = ? AND record_id > ?
				ORDER BY record_id LIMIT ?`,
				[captureId, afterRecordId, limit],
			);
			return {
				entries: rows.map((row) => ({
					address: {
						namespace: row.namespace,
						collection: row.collection,
						recordKey: row.record_key,
					},
					scalar:
						row.state === 'live'
							? {
									state: 'live',
									payload: JSON.parse(row.payload ?? '') as JsonValue,
								}
							: { state: 'unset' },
					documentUpdateV2:
						row.document_update_v2 === null
							? null
							: copyBytes(row.document_update_v2),
					blobSha256: row.blob_sha256,
				})),
				...(rows.length === limit
					? { nextAfterRecordId: rows.at(-1)?.record_id }
					: {}),
			};
		});
	}

	function finish(
		captureId: string,
		outcome: 'succeeded' | 'cancelled' | 'crashed',
	): void {
		validateCaptureId(captureId);
		database.transaction(() => {
			const current = manifest(database, captureId);
			if (
				current.state === 'succeeded' ||
				current.state === 'cancelled' ||
				current.state === 'crashed'
			) {
				if (current.state === outcome) return;
				throw new Error('capture manifest already has a terminal outcome');
			}
			if (outcome === 'succeeded' && current.state !== 'sealed') {
				throw new Error('only a sealed capture can succeed');
			}
			database.run(
				'UPDATE capture_manifests SET state = ? WHERE capture_id = ?',
				[outcome, captureId],
			);
			database.run(
				'DELETE FROM capture_manifest_records WHERE capture_id = ?',
				[captureId],
			);
		});
	}

	return Object.freeze({ start, advance, seal, readPage, finish });
}

/** Mark interrupted captures crashed and release their durable pins on reopen. */
export function recoverInterruptedCaptureManifests(
	database: SqliteDatabase,
): number {
	const pending = database.all<SqliteRow & { capture_id: string }>(
		`SELECT capture_id FROM capture_manifests
		WHERE state IN ('building', 'sealed')`,
	);
	if (pending.length === 0) return 0;
	return database.transaction(() => {
		const interrupted = database.all<SqliteRow & { capture_id: string }>(
			`SELECT capture_id FROM capture_manifests
			WHERE state IN ('building', 'sealed')`,
		);
		for (const row of interrupted) {
			database.run(
				'DELETE FROM capture_manifest_records WHERE capture_id = ?',
				[row.capture_id],
			);
		}
		database.run(
			`UPDATE capture_manifests SET state = 'crashed'
			WHERE state IN ('building', 'sealed')`,
		);
		return interrupted.length;
	});
}
