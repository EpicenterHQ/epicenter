/** Opaque immutable object publication under the current authority's SQLite owner. */
import {
	type BlobId,
	type BlobStore,
	blobKeyFormat,
	parseBlobId,
} from '@epicenter/blobs';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { type Result, tryAsync, trySync, unwrap } from 'wellcrafted/result';

export type BackupMetadata = {
	appId: string;
	dataId: string;
	version: number;
	source: { generation: number; head: number };
};
export type BackupReason = 'manual' | 'imported' | 'before-restore';
export type BackupRecord = BackupMetadata & {
	id: BlobId;
	library: string;
	digest: string;
	byteLength: number;
	addedAt: number;
	reason: BackupReason;
};

export const BackupError = defineErrors({
	BackupFailed: ({ cause }: { cause: unknown }) => ({
		message: `Backup operation failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	BackupNotFound: ({ id }: { id: string }) => ({
		message: `No published backup '${id}' in this library`,
		id,
	}),
});

export type BackupError = InferErrors<typeof BackupError>;

type BackupRow = SqliteRow & {
	id: BlobId;
	digest: string;
	byte_length: number;
	metadata: string;
	reason: BackupReason;
	added_at: number | null;
};
const ARCHIVE_CONTENT_TYPE = 'application/json;charset=utf-8';

/**
 * The whole-file digest a recovery record is identified by.
 *
 * One definition, because the catalog, the client journal and the coordinator
 * all compare against each other's value: three spellings of SHA-256 hex would
 * agree until one of them did not.
 */
export async function digestHex(bytes: Uint8Array): Promise<string> {
	return Array.from(
		new Uint8Array(
			await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
		),
		(byte) => byte.toString(16).padStart(2, '0'),
	).join('');
}

/**
 * Bind this SQLite owner to one library and application/data identity, once.
 *
 * Every durable recovery record here inherits its scope from the owner rather
 * than carrying it per row, so the check that the owner is the expected one has
 * to happen where the owner is opened. Reopening under a different identity
 * refuses instead of quietly writing a second library's history into this file.
 */
export function pinLibrary({
	sqlite,
	library,
	identity,
}: {
	sqlite: SqliteDatabase;
	library: string;
	identity: { appId: string; dataId: string };
}): void {
	const { appId, dataId } = identity;
	if (!library || !appId || !dataId)
		throw new Error('Backup library identity is required');
	sqlite.transaction(() => {
		sqlite.run(`CREATE TABLE IF NOT EXISTS _backup_library (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			library TEXT NOT NULL, app_id TEXT NOT NULL, data_id TEXT NOT NULL
		)`);
		sqlite.run('INSERT OR IGNORE INTO _backup_library VALUES (1, ?, ?, ?)', [
			library,
			appId,
			dataId,
		]);
		const held = sqlite.all<
			SqliteRow & { library: string; app_id: string; data_id: string }
		>('SELECT * FROM _backup_library')[0];
		if (
			held?.library !== library ||
			held.app_id !== appId ||
			held.data_id !== dataId
		)
			throw new Error('Backup catalog belongs to another library');
	});
}

/**
 * Internal authority composition. The host supplies an immutable archive store
 * isolated from generic blob deletion. The coordinator validates archive semantics;
 * this owner independently proves exact stored bytes before publishing metadata.
 * A retained request can retry across reopening. This is not an intent journal.
 */
export function openBackups({
	sqlite,
	library,
	identity,
	archives,
}: {
	sqlite: SqliteDatabase;
	library: string;
	identity: { appId: string; dataId: string };
	archives: Pick<BlobStore, 'put' | 'get'>;
}) {
	const appId = identity.appId;
	const dataId = identity.dataId;
	pinLibrary({ sqlite, library, identity });
	sqlite.transaction(() => {
		sqlite.run(`CREATE TABLE IF NOT EXISTS _backups (
			id TEXT PRIMARY KEY, digest TEXT NOT NULL, byte_length INTEGER NOT NULL,
			metadata TEXT NOT NULL, reason TEXT NOT NULL, added_at INTEGER
		)`);
	});

	function row(id: BlobId) {
		return sqlite.all<BackupRow>('SELECT * FROM _backups WHERE id = ?', [
			id,
		])[0];
	}
	function record(row: BackupRow): BackupRecord {
		if (row.added_at === null) throw new Error('Backup is not published');
		return {
			...(JSON.parse(row.metadata) as BackupMetadata),
			id: row.id,
			library,
			digest: row.digest,
			byteLength: row.byte_length,
			addedAt: row.added_at,
			reason: row.reason,
		};
	}

	return {
		/** Private request identity belongs to recovery, never to an application caller. */
		async publish(request: {
			id: BlobId;
			reason: BackupReason;
			bytes: Uint8Array;
			metadata: BackupMetadata;
		}) {
			// Take ownership before the first await, including nested metadata.
			const { id, reason } = request;
			const bytes = new Uint8Array(request.bytes);
			const metadata = JSON.stringify({
				appId: request.metadata.appId,
				dataId: request.metadata.dataId,
				version: request.metadata.version,
				source: { ...request.metadata.source },
			});
			return tryAsync({
				try: async () => {
					const parsed = JSON.parse(metadata) as BackupMetadata;
					if (
						!parseBlobId(id) ||
						blobKeyFormat(id).extension !== 'json' ||
						!['manual', 'imported', 'before-restore'].includes(reason) ||
						parsed.appId !== appId ||
						parsed.dataId !== dataId ||
						![
							parsed.version,
							parsed.source.generation,
							parsed.source.head,
						].every((n) => Number.isSafeInteger(n) && n > 0) ||
						!bytes.length
					)
						throw new Error('Invalid backup request or application identity');
					const hash = await digestHex(bytes);
					const previous = sqlite.transaction(() => {
						const previous = row(id);
						if (previous) {
							if (
								previous.digest !== hash ||
								previous.byte_length !== bytes.length ||
								previous.metadata !== metadata ||
								previous.reason !== reason
							)
								throw new Error(
									'Backup reservation conflicts with retained request',
								);
							return previous;
						}
						sqlite.run('INSERT INTO _backups VALUES (?, ?, ?, ?, ?, NULL)', [
							id,
							hash,
							bytes.length,
							metadata,
							reason,
						]);
					});
					// A committed retry resolves without depending on object storage availability.
					if (previous?.added_at != null) return record(previous);
					const written = await archives.put(
						id,
						new Blob([bytes], { type: ARCHIVE_CONTENT_TYPE }),
					);
					if (
						written.error !== null &&
						written.error.name !== 'BlobAlreadyExists'
					)
						throw written.error;
					const saved = unwrap(await archives.get(id));
					const actual = new Uint8Array(await saved.arrayBuffer());
					if (
						saved.type !== ARCHIVE_CONTENT_TYPE ||
						actual.length !== bytes.length ||
						actual.some((byte, index) => byte !== bytes[index])
					)
						throw new Error(
							'Immutable archive read-back differs from submitted bytes or MIME type',
						);
					return sqlite.transaction(() => {
						sqlite.run(
							'UPDATE _backups SET added_at = ? WHERE id = ? AND added_at IS NULL',
							[Date.now(), id],
						);
						const published = row(id);
						if (!published) throw new Error('Backup reservation disappeared');
						return record(published);
					});
				},
				catch: (cause) => BackupError.BackupFailed({ cause }),
			});
		},
		list() {
			return trySync({
				try: () =>
					sqlite.transaction(() =>
						sqlite
							.all<BackupRow>(
								'SELECT * FROM _backups WHERE added_at IS NOT NULL ORDER BY added_at DESC, id',
							)
							.map(record),
					),
				catch: (cause) => BackupError.BackupFailed({ cause }),
			});
		},
		async download(
			id: BlobId,
		): Promise<Result<Uint8Array<ArrayBuffer>, BackupError>> {
			const selected = trySync({
				try: () => sqlite.transaction(() => row(id)),
				catch: (cause) => BackupError.BackupFailed({ cause }),
			});
			if (selected.error !== null) return selected;
			if (!selected.data || selected.data.added_at === null)
				return BackupError.BackupNotFound({ id });
			const expected = selected.data;
			return tryAsync({
				try: async () => {
					const blob = unwrap(await archives.get(id));
					const bytes = new Uint8Array(await blob.arrayBuffer());
					if (
						blob.type !== ARCHIVE_CONTENT_TYPE ||
						bytes.length !== expected.byte_length ||
						(await digestHex(bytes)) !== expected.digest
					)
						throw new Error(
							'Stored archive does not match the published digest, length or MIME type',
						);
					return bytes;
				},
				catch: (cause) => BackupError.BackupFailed({ cause }),
			});
		},
	};
}
