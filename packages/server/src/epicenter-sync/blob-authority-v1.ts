import {
	BLOB_PUBLICATION_VERSION,
	type BlobAcceptance,
	type BlobFileStore,
	type BlobPublicationReceipt,
	type BlobPublicationRequest,
	blobFileOwner,
	isBlobDigest,
	type OwnedBlobFile,
} from '@epicenter/data/blob-v1';
import type { RecordAddress } from '@epicenter/data/protocol/v1';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';

const TRIPLE_WHERE = 'namespace = ? AND collection = ? AND record_key = ?';

type RecordRow = SqliteRow & {
	state: 'live' | 'tombstone' | 'unset';
	accepted_blob_sha256: string | null;
};

type MetaRow = SqliteRow & {
	authority_lifetime: string;
	next_capture_revision: number;
};

function one<TRow extends SqliteRow>(
	database: SqliteDatabase,
	sql: string,
	parameters: readonly (string | number | null)[] = [],
): TRow | null {
	return database.all<TRow>(sql, parameters)[0] ?? null;
}

function tripleParams(address: RecordAddress): [string, string, string] {
	return [address.namespace, address.collection, address.recordKey];
}

function receiptFor(request: BlobPublicationRequest): BlobPublicationReceipt {
	return structuredClone(request);
}

/** Record-owned immutable blob acceptance inside one principal authority. */
export function createAuthorityBlobV1<TSource, TRead>(
	database: SqliteDatabase,
	files: BlobFileStore<TSource, TRead>,
) {
	let tail = Promise.resolve();
	function exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = tail.then(operation, operation);
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	function ownedFiles(): OwnedBlobFile[] {
		return database
			.all<
				SqliteRow & {
					namespace: string;
					collection: string;
					record_key: string;
					accepted_blob_sha256: string;
				}
			>(
				`SELECT namespace, collection, record_key, accepted_blob_sha256
				FROM records WHERE accepted_blob_sha256 IS NOT NULL
				UNION
				SELECT pinned.namespace, pinned.collection, pinned.record_key,
					pinned.blob_sha256 AS accepted_blob_sha256
				FROM capture_manifest_records AS pinned
				JOIN capture_manifests AS manifest
					ON manifest.capture_id = pinned.capture_id
				WHERE pinned.blob_sha256 IS NOT NULL
					AND manifest.state IN ('building', 'sealed')`,
			)
			.map((row) =>
				blobFileOwner(
					{
						namespace: row.namespace,
						collection: row.collection,
						recordKey: row.record_key,
					},
					row.accepted_blob_sha256,
				),
			);
	}

	async function accept(
		request: BlobPublicationRequest,
		source: TSource,
	): Promise<BlobAcceptance> {
		return exclusive(async () => {
			if (
				request.protocolVersion !== BLOB_PUBLICATION_VERSION ||
				!isBlobDigest(request.digest)
			) {
				throw new TypeError('invalid blob publication request');
			}
			const meta = one<SqliteRow & { authority_lifetime: string }>(
				database,
				'SELECT authority_lifetime FROM meta WHERE singleton = 1',
			);
			if (meta === null) throw new Error('authority metadata is missing');
			if (request.authorityLifetime !== meta.authority_lifetime) {
				return {
					kind: 'lifetime-mismatch',
					activeAuthorityLifetime: meta.authority_lifetime,
				};
			}
			const staged = await files.stage(source);
			if (staged.digest !== request.digest) {
				await files.sweepStaging();
				throw new Error('blob publication bytes do not match their digest');
			}
			await files.promote(
				staged,
				blobFileOwner(request.address, request.digest),
			);

			const result = database.transaction((): BlobAcceptance => {
				const currentMeta = one<MetaRow>(
					database,
					`SELECT authority_lifetime, next_capture_revision
					FROM meta WHERE singleton = 1`,
				);
				if (currentMeta === null) {
					throw new Error('authority metadata is missing');
				}
				if (request.authorityLifetime !== currentMeta.authority_lifetime) {
					return {
						kind: 'lifetime-mismatch',
						activeAuthorityLifetime: currentMeta.authority_lifetime,
					};
				}
				const row = one<RecordRow>(
					database,
					`SELECT state, accepted_blob_sha256 FROM records
					WHERE ${TRIPLE_WHERE}`,
					tripleParams(request.address),
				);
				if (row === null) {
					return {
						kind: 'record-not-live',
						activeAuthorityLifetime: currentMeta.authority_lifetime,
						address: structuredClone(request.address),
						state: 'absent',
					};
				}
				if (row.state !== 'live') {
					return {
						kind: 'record-not-live',
						activeAuthorityLifetime: currentMeta.authority_lifetime,
						address: structuredClone(request.address),
						state: row.state,
					};
				}
				if (
					row.accepted_blob_sha256 !== null &&
					row.accepted_blob_sha256 !== request.digest
				) {
					return {
						kind: 'blob-conflict',
						receipt: receiptFor(request),
						acceptedDigest: row.accepted_blob_sha256,
					};
				}
				if (row.accepted_blob_sha256 === null) {
					if (!Number.isSafeInteger(currentMeta.next_capture_revision)) {
						throw new Error('authority capture revision exhausted');
					}
					database.run(
						`UPDATE records SET accepted_blob_sha256 = ?, capture_revision = ?
						WHERE ${TRIPLE_WHERE}`,
						[
							request.digest,
							currentMeta.next_capture_revision,
							...tripleParams(request.address),
						],
					);
					database.run(
						`UPDATE meta SET next_capture_revision = ? WHERE singleton = 1`,
						[currentMeta.next_capture_revision + 1],
					);
				}
				return { kind: 'accepted', receipt: receiptFor(request) };
			});
			await files.sweepContent(ownedFiles());
			return result;
		});
	}

	async function read(address: RecordAddress): Promise<TRead | undefined> {
		return exclusive(async () => {
			const row = one<RecordRow>(
				database,
				`SELECT state, accepted_blob_sha256 FROM records
				WHERE ${TRIPLE_WHERE}`,
				tripleParams(address),
			);
			if (row?.state !== 'live' || row.accepted_blob_sha256 === null) {
				return undefined;
			}
			return files.open(blobFileOwner(address, row.accepted_blob_sha256));
		});
	}

	async function readCapture(
		captureId: string,
		address: RecordAddress,
		digest: string,
	): Promise<TRead | undefined> {
		return exclusive(async () => {
			const pinned = one<SqliteRow & { present: number }>(
				database,
				`SELECT 1 AS present
				FROM capture_manifest_records AS pinned
				JOIN capture_manifests AS manifest
					ON manifest.capture_id = pinned.capture_id
				WHERE pinned.capture_id = ?
					AND pinned.namespace = ? AND pinned.collection = ?
					AND pinned.record_key = ? AND pinned.blob_sha256 = ?
					AND manifest.state = 'sealed'`,
				[captureId, ...tripleParams(address), digest],
			);
			if (pinned === null) return undefined;
			return files.open(blobFileOwner(address, digest));
		});
	}

	async function sweepDebris(): Promise<void> {
		return exclusive(() => files.sweepContent(ownedFiles()));
	}

	async function reopenSweep(): Promise<void> {
		return exclusive(async () => {
			await files.sweepStaging();
			await files.sweepContent(ownedFiles());
		});
	}

	async function deleteAll(): Promise<void> {
		return exclusive(async () => {
			await files.sweepStaging();
			await files.sweepContent([]);
		});
	}

	return { accept, read, readCapture, sweepDebris, reopenSweep, deleteAll };
}

export type AuthorityBlobV1<TSource, TRead> = ReturnType<
	typeof createAuthorityBlobV1<TSource, TRead>
>;
