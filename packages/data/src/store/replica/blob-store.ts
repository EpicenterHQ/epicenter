import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';

import {
	BLOB_PUBLICATION_VERSION,
	type BlobAcceptance,
	type BlobFileStore,
	type BlobPublicationReceipt,
	type BlobPublicationRequest,
	BlobSourceReadFailure,
	blobFileOwner,
	isBlobDigest,
} from '../../blob-v1/index.js';
import { addressesEqual, type RecordAddress } from '../../protocol/v1/index.js';

const TRIPLE_WHERE = 'namespace = ? AND collection = ? AND record_key = ?';

type BlobRow = SqliteRow & {
	record_id: number;
	confirmed_state: 'live' | 'tombstone' | 'unset' | null;
	sealed_op: 'patch' | 'replace' | 'tombstone' | 'unset' | null;
	pending_op: 'patch' | 'replace' | 'tombstone' | 'unset' | null;
	blob_sha256: string | null;
	blob_accepted_sha256: string | null;
	blob_parked_code: 'blob-conflict' | 'record-not-live' | null;
};

export type BlobInspection =
	| { kind: 'absent' }
	| {
			kind: 'accepted' | 'owed' | 'parked';
			digest: string;
			parkedCode?: 'blob-conflict' | 'record-not-live';
	  };

export type BlobPublication<TRead> = {
	request: BlobPublicationRequest;
	bytes: TRead;
};

export type BlobCaptureOutcome =
	| { kind: 'captured'; digest: string }
	| { kind: 'record-not-live'; state: RecordNotLiveState }
	| { kind: 'blob-conflict' }
	| { kind: 'source-read-failed'; cause: unknown };

export type BlobPublicationState<TRead> =
	| { kind: 'settled' }
	| { kind: 'ready'; publication: BlobPublication<TRead> }
	| { kind: 'record-not-live'; state: RecordNotLiveState };

export type BlobSettlementOutcome =
	| { kind: 'settled' }
	| { kind: 'record-not-live'; state: RecordNotLiveState };

type RecordNotLiveState = 'absent' | 'unset' | 'tombstone';

type BlobFaultHooks = {
	afterStage?: () => void;
	afterPromote?: () => void;
	afterMembership?: () => void;
};

function tripleParams(address: RecordAddress): [string, string, string] {
	return [address.namespace, address.collection, address.recordKey];
}

function one<TRow extends SqliteRow>(
	database: SqliteDatabase,
	sql: string,
	parameters: readonly (string | number | null)[] = [],
): TRow | null {
	return database.all<TRow>(sql, parameters)[0] ?? null;
}

function rowFor(
	database: SqliteDatabase,
	address: RecordAddress,
): BlobRow | null {
	return one<BlobRow>(
		database,
		`SELECT record_id, confirmed_state, sealed_op, pending_op,
			blob_sha256, blob_accepted_sha256, blob_parked_code
		FROM records WHERE ${TRIPLE_WHERE}`,
		tripleParams(address),
	);
}

function liveRecord(
	database: SqliteDatabase,
	address: RecordAddress,
):
	| { kind: 'live'; row: BlobRow }
	| { kind: 'record-not-live'; state: RecordNotLiveState } {
	const row = rowFor(database, address);
	if (row === null) return { kind: 'record-not-live', state: 'absent' };
	if (
		row.confirmed_state === 'tombstone' ||
		row.sealed_op === 'tombstone' ||
		row.pending_op === 'tombstone'
	) {
		return { kind: 'record-not-live', state: 'tombstone' };
	}
	const newestOperation = row.pending_op ?? row.sealed_op;
	const visibleLive =
		newestOperation === 'patch' ||
		newestOperation === 'replace' ||
		(newestOperation === null && row.confirmed_state === 'live');
	if (!visibleLive) return { kind: 'record-not-live', state: 'unset' };
	return { kind: 'live', row };
}

function requireLiveRecord(
	database: SqliteDatabase,
	address: RecordAddress,
): BlobRow {
	const outcome = liveRecord(database, address);
	if (outcome.kind === 'live') return outcome.row;
	switch (outcome.state) {
		case 'absent':
			throw new Error('blob record is absent');
		case 'tombstone':
			throw new Error('blob record is tombstoned');
		case 'unset':
			throw new Error('blob record is not live');
		default:
			return outcome.state satisfies never;
	}
}

/** The derived obligation: local durable truth without a matching authority proof. */
function isOwed(row: BlobRow): boolean {
	return (
		row.blob_sha256 !== null && row.blob_accepted_sha256 !== row.blob_sha256
	);
}

function matchingProof(
	request: BlobPublicationRequest,
	proof: BlobPublicationReceipt,
): boolean {
	return (
		proof.protocolVersion === BLOB_PUBLICATION_VERSION &&
		proof.authorityLifetime === request.authorityLifetime &&
		proof.digest === request.digest &&
		addressesEqual(proof.address, request.address)
	);
}

/**
 * Compose one SQLite replica with a runtime-owned streaming blob filesystem.
 *
 * `blob_sha256` is local durable truth and `blob_accepted_sha256` is the
 * authority's proof for the active lifetime; their inequality derives the
 * publication obligation. Calls are serialized because file promotion and
 * SQLite membership form one owner protocol even though they cannot share a
 * transaction.
 */
export function createReplicaBlobStore<TSource, TRead>(
	database: SqliteDatabase,
	files: BlobFileStore<TSource, TRead>,
	hooks: BlobFaultHooks = {},
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

	function inspect(address: RecordAddress): BlobInspection {
		const row = rowFor(database, address);
		if (row === null || row.blob_sha256 === null) return { kind: 'absent' };
		if (row.blob_parked_code !== null) {
			return {
				kind: 'parked',
				digest: row.blob_sha256,
				parkedCode: row.blob_parked_code,
			};
		}
		return {
			kind: isOwed(row) ? 'owed' : 'accepted',
			digest: row.blob_sha256,
		};
	}

	async function capture(
		address: RecordAddress,
		source: TSource,
	): Promise<BlobCaptureOutcome> {
		return exclusive(async () => {
			// Refuse ordinary invalid ownership before streaming bytes into staging.
			// The post-stage check below still fences a liveness race.
			const initialOwner = liveRecord(database, address);
			if (initialOwner.kind === 'record-not-live') return initialOwner;
			let staged;
			try {
				staged = await files.stage(source);
			} catch (cause) {
				await files.sweepStaging();
				if (!(cause instanceof BlobSourceReadFailure)) throw cause;
				return {
					kind: 'source-read-failed',
					cause: cause.sourceCause,
				};
			}
			if (!isBlobDigest(staged.digest)) {
				await files.sweepStaging();
				throw new Error('blob file store returned an invalid digest');
			}
			hooks.afterStage?.();
			try {
				const beforeOwner = liveRecord(database, address);
				if (beforeOwner.kind === 'record-not-live') {
					await files.sweepStaging();
					return beforeOwner;
				}
				const before = beforeOwner.row;
				if (
					before.blob_sha256 !== null &&
					before.blob_sha256 !== staged.digest
				) {
					await files.sweepStaging();
					return { kind: 'blob-conflict' };
				}
				const owner = blobFileOwner(address, staged.digest);
				await files.promote(staged, owner);
				hooks.afterPromote?.();
				const membership = database.transaction((): BlobCaptureOutcome => {
					const currentOwner = liveRecord(database, address);
					if (currentOwner.kind === 'record-not-live') return currentOwner;
					const row = currentOwner.row;
					if (row.blob_sha256 !== null && row.blob_sha256 !== staged.digest) {
						return { kind: 'blob-conflict' };
					}
					if (row.blob_sha256 === null) {
						database.run(
							`UPDATE records SET blob_sha256 = ?, blob_accepted_sha256 = NULL,
								blob_parked_code = NULL WHERE ${TRIPLE_WHERE}`,
							[staged.digest, ...tripleParams(address)],
						);
					}
					return { kind: 'captured', digest: staged.digest };
				});
				if (membership.kind !== 'captured') {
					await files.sweepStaging();
					return membership;
				}
			} catch (cause) {
				await files.sweepStaging();
				throw cause;
			}
			hooks.afterMembership?.();
			return { kind: 'captured', digest: staged.digest };
		});
	}

	async function publication(
		address: RecordAddress,
	): Promise<BlobPublicationState<TRead>> {
		return exclusive(async () => {
			const owner = liveRecord(database, address);
			if (owner.kind === 'record-not-live') return owner;
			const row = owner.row;
			if (
				row.blob_sha256 === null ||
				!isOwed(row) ||
				row.blob_parked_code !== null
			) {
				return { kind: 'settled' };
			}
			const meta = one<SqliteRow & { authority_lifetime: string | null }>(
				database,
				'SELECT authority_lifetime FROM meta WHERE singleton = 1',
			);
			if (meta?.authority_lifetime === null || meta === null) {
				throw new Error('cannot publish a blob before lifetime binding');
			}
			const request: BlobPublicationRequest = {
				authorityLifetime: meta.authority_lifetime,
				address: structuredClone(address),
				protocolVersion: BLOB_PUBLICATION_VERSION,
				digest: row.blob_sha256,
			};
			return {
				kind: 'ready',
				publication: {
					request,
					bytes: await files.open(blobFileOwner(address, row.blob_sha256)),
				},
			};
		});
	}

	async function settle(
		address: RecordAddress,
		acceptance: BlobAcceptance,
	): Promise<BlobSettlementOutcome> {
		return exclusive(async () =>
			database.transaction(() => {
				const owner = liveRecord(database, address);
				if (owner.kind === 'record-not-live') return owner;
				const row = owner.row;
				if (row.blob_sha256 === null || !isOwed(row)) {
					throw new Error('no blob publication is owed');
				}
				const meta = one<SqliteRow & { authority_lifetime: string | null }>(
					database,
					'SELECT authority_lifetime FROM meta WHERE singleton = 1',
				);
				if (meta?.authority_lifetime === null || meta === null) {
					throw new Error('blob replica has no authority lifetime');
				}
				const request: BlobPublicationRequest = {
					authorityLifetime: meta.authority_lifetime,
					address,
					protocolVersion: BLOB_PUBLICATION_VERSION,
					digest: row.blob_sha256,
				};
				if (acceptance.kind === 'lifetime-mismatch') {
					throw new Error('lifetime mismatch: erase and reacquire instead');
				}
				if (acceptance.kind === 'record-not-live') {
					if (
						acceptance.activeAuthorityLifetime !== request.authorityLifetime ||
						!addressesEqual(acceptance.address, request.address)
					) {
						throw new Error(
							'blob acceptance does not match the owed publication',
						);
					}
					database.run(
						`UPDATE records SET blob_parked_code = 'record-not-live'
					WHERE ${TRIPLE_WHERE}`,
						tripleParams(address),
					);
					return { kind: 'settled' };
				}
				if (!matchingProof(request, acceptance.receipt)) {
					throw new Error(
						'blob acceptance does not match the owed publication',
					);
				}
				if (acceptance.kind === 'accepted') {
					database.run(
						`UPDATE records SET blob_accepted_sha256 = blob_sha256,
							blob_parked_code = NULL
					WHERE ${TRIPLE_WHERE}`,
						tripleParams(address),
					);
					return { kind: 'settled' };
				}
				database.run(
					`UPDATE records SET blob_parked_code = ? WHERE ${TRIPLE_WHERE}`,
					['blob-conflict', ...tripleParams(address)],
				);
				return { kind: 'settled' };
			}),
		);
	}

	async function read(address: RecordAddress): Promise<TRead | null> {
		return exclusive(async () => {
			const row = requireLiveRecord(database, address);
			return row.blob_sha256 === null
				? null
				: files.open(blobFileOwner(address, row.blob_sha256));
		});
	}

	async function sweepDebris(): Promise<void> {
		return exclusive(async () => {
			const owned = database
				.all<
					SqliteRow & {
						namespace: string;
						collection: string;
						record_key: string;
						blob_sha256: string;
					}
				>(
					`SELECT namespace, collection, record_key, blob_sha256
					FROM records WHERE blob_sha256 IS NOT NULL`,
				)
				.map((row) =>
					blobFileOwner(
						{
							namespace: row.namespace,
							collection: row.collection,
							recordKey: row.record_key,
						},
						row.blob_sha256,
					),
				);
			await files.sweepContent(owned);
		});
	}

	async function reopenSweep(): Promise<void> {
		await exclusive(() => files.sweepStaging());
		await sweepDebris();
	}

	return {
		capture,
		inspect,
		publication,
		settle,
		read,
		sweepDebris,
		reopenSweep,
	};
}

export type ReplicaBlobStore<TSource, TRead> = ReturnType<
	typeof createReplicaBlobStore<TSource, TRead>
>;
