import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import {
	DOCUMENT_BOUND,
	type DocumentMeasure,
	exceedsDocumentBound,
	measureDocumentState,
} from '@epicenter/sync/document-v3';
import * as Y from '@y/y';

import {
	DOCUMENT_PUBLICATION_VERSION,
	type DocumentBoundRefusal,
	type DocumentPublicationReceipt,
	type DocumentPublicationRequest,
	documentPayloadDigest,
} from '../../document-v1/index.js';
import { addressesEqual, type RecordAddress } from '../../protocol/v1/index.js';

const TRIPLE_WHERE = 'namespace = ? AND collection = ? AND record_key = ?';
const hydrationOrigin = Symbol('epicenter-v1-document-hydration');

export const DOCUMENT_CHAIN_LIMITS = {
	tailEntries: 64,
	tailBytes: 1_048_576,
} as const;

type RecordRow = SqliteRow & {
	record_id: number;
	confirmed_state: 'live' | 'tombstone' | 'unset' | null;
	sealed_op: 'patch' | 'replace' | 'tombstone' | 'unset' | null;
	pending_op: 'patch' | 'replace' | 'tombstone' | 'unset' | null;
	document_revision: number;
	document_accepted_revision: number;
	document_refused_revision: number | null;
	document_refused_bytes: number | null;
	document_refused_structs: number | null;
};

type ChainRow = SqliteRow & {
	seq: number;
	kind: 'baseline' | 'update';
	bytes: Uint8Array | ArrayBuffer;
};

export type DocumentInspection = {
	revision: number;
	acceptedRevision: number;
	owed: boolean;
	chainBytes: number;
	refused: boolean;
};

/**
 * One encoded publication attempt. The captured revision and payload digest
 * exist only in memory: process loss regenerates the attempt from the durable
 * chain instead of restoring exact in-flight bytes.
 */
export type CapturedDocumentPublication = DocumentPublicationRequest & {
	capturedRevision: number;
};

/** Durable diagnostic for a revision the authority (or local measurement) refused. */
export type DocumentRefusalEvidence = {
	revision: number;
	measured: DocumentMeasure;
	limit: DocumentMeasure;
};

export type DocumentPublicationState =
	| { kind: 'settled' }
	| { kind: 'not-settled' }
	| { kind: 'ready'; publication: CapturedDocumentPublication }
	| { kind: 'refused'; refusal: DocumentRefusalEvidence };

type DocumentChainOptions = {
	tailEntries?: number;
	tailBytes?: number;
};

function tripleParams(address: RecordAddress): [string, string, string] {
	return [address.namespace, address.collection, address.recordKey];
}

function copyBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
	return value instanceof Uint8Array
		? new Uint8Array(value)
		: new Uint8Array(value.slice(0));
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
): RecordRow | null {
	return one<RecordRow>(
		database,
		`SELECT record_id, confirmed_state, sealed_op, pending_op,
			document_revision, document_accepted_revision,
			document_refused_revision, document_refused_bytes,
			document_refused_structs
		FROM records WHERE ${TRIPLE_WHERE}`,
		tripleParams(address),
	);
}

function requireDocumentOwner(
	database: SqliteDatabase,
	address: RecordAddress,
): RecordRow {
	const row = rowFor(database, address);
	if (row === null) throw new Error('document record is absent');
	if (
		row.confirmed_state === 'tombstone' ||
		row.sealed_op === 'tombstone' ||
		row.pending_op === 'tombstone'
	) {
		throw new Error('document record is tombstoned');
	}
	const newestOperation = row.pending_op ?? row.sealed_op;
	const isVisibleLive =
		newestOperation === 'patch' ||
		newestOperation === 'replace' ||
		(newestOperation === null && row.confirmed_state === 'live');
	const isReversibleUnset =
		newestOperation === 'unset' ||
		(newestOperation === null && row.confirmed_state === 'unset');
	if (
		!isVisibleLive &&
		(!isReversibleUnset || chainFor(database, row.record_id).length === 0)
	) {
		throw new Error('document record is not live');
	}
	return row;
}

function chainFor(database: SqliteDatabase, recordId: number): ChainRow[] {
	return database.all<ChainRow>(
		`SELECT seq, kind, bytes FROM record_documents
		WHERE record_id = ? ORDER BY seq`,
		[recordId],
	);
}

function hydrate(chain: readonly ChainRow[]): Y.Doc {
	const document = new Y.Doc({ gc: true });
	try {
		for (const entry of chain) {
			Y.applyUpdateV2(document, copyBytes(entry.bytes), hydrationOrigin);
		}
		return document;
	} catch (cause) {
		document.destroy();
		throw cause;
	}
}

function authorityLifetimeOf(database: SqliteDatabase): string {
	const meta = one<SqliteRow & { authority_lifetime: string | null }>(
		database,
		'SELECT authority_lifetime FROM meta WHERE singleton = 1',
	);
	if (meta?.authority_lifetime === null || meta === null) {
		throw new Error('cannot publish a document before lifetime binding');
	}
	return meta.authority_lifetime;
}

/**
 * Record-owned bounded document chains and publication watermarks.
 *
 * The durable obligation is derived, never stored: a document is owed exactly
 * while `document_revision > document_accepted_revision`. Publication encodes
 * a fresh attempt from the chain on every call; the accepted watermark
 * advances only on a matching post-commit proof, and only to the revision
 * whose bytes were captured.
 */
export function createReplicaDocumentStore(
	database: SqliteDatabase,
	options: DocumentChainOptions = {},
) {
	const tailEntries = options.tailEntries ?? DOCUMENT_CHAIN_LIMITS.tailEntries;
	const tailBytes = options.tailBytes ?? DOCUMENT_CHAIN_LIMITS.tailBytes;
	if (!Number.isSafeInteger(tailEntries) || tailEntries < 1) {
		throw new RangeError('document tail entry threshold must be positive');
	}
	if (!Number.isSafeInteger(tailBytes) || tailBytes < 1) {
		throw new RangeError('document tail byte threshold must be positive');
	}

	function append(
		address: RecordAddress,
		update: Uint8Array,
		kind: 'local' | 'accepted',
	): void {
		if (!(update instanceof Uint8Array) || update.byteLength === 0) {
			throw new TypeError('document update must contain bytes');
		}
		const ownedUpdate = new Uint8Array(update);
		database.transaction(() => {
			const row = requireDocumentOwner(database, address);
			const chain = chainFor(database, row.record_id);
			const document = hydrate(chain);
			try {
				const before = new Uint8Array(Y.encodeStateAsUpdateV2(document));
				Y.applyUpdateV2(document, ownedUpdate, hydrationOrigin);
				const after = new Uint8Array(Y.encodeStateAsUpdateV2(document));
				if (
					before.byteLength === after.byteLength &&
					before.every((byte, index) => byte === after[index])
				) {
					return;
				}
				const tail = chain.filter((entry) => entry.kind === 'update');
				const tailLength = tail.reduce(
					(total, entry) => total + copyBytes(entry.bytes).byteLength,
					0,
				);
				const compact =
					tail.length + 1 > tailEntries ||
					tailLength + ownedUpdate.byteLength > tailBytes;
				if (compact) {
					const baseline = after;
					database.run('DELETE FROM record_documents WHERE record_id = ?', [
						row.record_id,
					]);
					database.run(
						`INSERT INTO record_documents (record_id, seq, kind, bytes)
						VALUES (?, 1, 'baseline', ?)`,
						[row.record_id, baseline],
					);
				} else {
					const nextSequence = chain.at(-1)?.seq ?? 0;
					database.run(
						`INSERT INTO record_documents (record_id, seq, kind, bytes)
						VALUES (?, ?, 'update', ?)`,
						[row.record_id, nextSequence + 1, ownedUpdate],
					);
				}
				if (
					kind === 'local' &&
					row.document_revision === Number.MAX_SAFE_INTEGER
				) {
					throw new Error('document revision space is exhausted');
				}
				// Either append changes the merged state, so any recorded refusal
				// describes a superseded state and is cleared. Only a local edit
				// creates a new obligation: a remote accepted install never
				// increments the locally authored revision.
				database.run(
					kind === 'local'
						? `UPDATE records SET
								document_revision = document_revision + 1,
								document_refused_revision = NULL,
								document_refused_bytes = NULL,
								document_refused_structs = NULL
							WHERE record_id = ?`
						: `UPDATE records SET
								document_refused_revision = NULL,
								document_refused_bytes = NULL,
								document_refused_structs = NULL
							WHERE record_id = ?`,
					[row.record_id],
				);
			} finally {
				document.destroy();
			}
		});
	}

	function inspect(address: RecordAddress): DocumentInspection | null {
		const row = rowFor(database, address);
		if (row === null) return null;
		const aggregate = one<SqliteRow & { entries: number; bytes: number }>(
			database,
			`SELECT count(*) AS entries, COALESCE(sum(length(bytes)), 0) AS bytes
			FROM record_documents WHERE record_id = ?`,
			[row.record_id],
		);
		if ((aggregate?.entries ?? 0) === 0) return null;
		return {
			revision: row.document_revision,
			acceptedRevision: row.document_accepted_revision,
			owed: row.document_revision > row.document_accepted_revision,
			chainBytes: aggregate?.bytes ?? 0,
			refused: row.document_refused_revision !== null,
		};
	}

	function exportDocument(address: RecordAddress): Uint8Array | undefined {
		const row = rowFor(database, address);
		if (row === null) return undefined;
		const chain = chainFor(database, row.record_id);
		if (chain.length === 0) return undefined;
		const document = hydrate(chain);
		try {
			return new Uint8Array(Y.encodeStateAsUpdateV2(document));
		} finally {
			document.destroy();
		}
	}

	function publication(address: RecordAddress): DocumentPublicationState {
		return database.transaction(() => {
			const row = requireDocumentOwner(database, address);
			if (row.document_revision <= row.document_accepted_revision) {
				return { kind: 'settled' };
			}
			const authorityLifetime = authorityLifetimeOf(database);
			const chain = chainFor(database, row.record_id);
			if (chain.length === 0) {
				throw new Error('owed document has no persisted chain');
			}
			const document = hydrate(chain);
			try {
				if (
					document.store.pendingStructs !== null ||
					document.store.pendingDs !== null
				) {
					return { kind: 'not-settled' };
				}
				const encodedState = new Uint8Array(Y.encodeStateAsUpdateV2(document));
				const measured = measureDocumentState(encodedState);
				if (exceedsDocumentBound(measured)) {
					database.run(
						`UPDATE records SET
							document_refused_revision = document_revision,
							document_refused_bytes = ?,
							document_refused_structs = ?
						WHERE record_id = ?`,
						[measured.stateBytes, measured.stateStructs, row.record_id],
					);
					return {
						kind: 'refused',
						refusal: {
							revision: row.document_revision,
							measured,
							limit: DOCUMENT_BOUND,
						},
					};
				}
				// Publication always carries the complete compact state. A state vector
				// that is stale, guessed, or obtained from another authority cannot omit
				// local structs and then turn the resulting digest into settlement proof.
				const payload = encodedState;
				return {
					kind: 'ready',
					publication: {
						authorityLifetime,
						address: structuredClone(address),
						protocolVersion: DOCUMENT_PUBLICATION_VERSION,
						payload,
						digest: documentPayloadDigest(payload),
						capturedRevision: row.document_revision,
					},
				};
			} finally {
				document.destroy();
			}
		});
	}

	function settle(
		address: RecordAddress,
		proof: DocumentPublicationReceipt | DocumentBoundRefusal,
		captured: { revision: number; digest: string },
	): void {
		database.transaction(() => {
			if (
				!addressesEqual(address, proof.address) ||
				proof.protocolVersion !== DOCUMENT_PUBLICATION_VERSION
			) {
				throw new Error(
					'document publication proof does not match its address',
				);
			}
			if (proof.digest !== captured.digest) {
				throw new Error(
					'document publication proof does not match the captured attempt',
				);
			}
			if (!Number.isSafeInteger(captured.revision) || captured.revision < 1) {
				throw new Error('captured document revision is invalid');
			}
			const meta = one<SqliteRow & { authority_lifetime: string | null }>(
				database,
				'SELECT authority_lifetime FROM meta WHERE singleton = 1',
			);
			if (meta?.authority_lifetime !== proof.authorityLifetime) {
				throw new Error('document publication proof lifetime mismatch');
			}
			const row = requireDocumentOwner(database, address);
			if (captured.revision > row.document_revision) {
				throw new Error('captured revision is beyond the local revision');
			}
			if ('kind' in proof) {
				// A refusal binds the captured revision. A racing local edit already
				// superseded it, so obsolete refusals are dropped, not recorded.
				if (row.document_revision !== captured.revision) return;
				const document = hydrate(chainFor(database, row.record_id));
				let currentDigest: string;
				try {
					currentDigest = documentPayloadDigest(
						new Uint8Array(Y.encodeStateAsUpdateV2(document)),
					);
				} finally {
					document.destroy();
				}
				if (currentDigest !== captured.digest) return;
				database.run(
					`UPDATE records SET
						document_refused_revision = ?,
						document_refused_bytes = ?,
						document_refused_structs = ?
					WHERE record_id = ?`,
					[
						captured.revision,
						proof.measured.stateBytes,
						proof.measured.stateStructs,
						row.record_id,
					],
				);
				return;
			}
			// Advance monotonically, and only to the revision whose bytes were
			// captured: a delayed receipt can never settle newer racing work.
			if (captured.revision <= row.document_accepted_revision) return;
			const clearsRefusal =
				row.document_refused_revision !== null &&
				row.document_refused_revision <= captured.revision;
			database.run(
				clearsRefusal
					? `UPDATE records SET
							document_accepted_revision = ?,
							document_refused_revision = NULL,
							document_refused_bytes = NULL,
							document_refused_structs = NULL
						WHERE record_id = ?`
					: `UPDATE records SET document_accepted_revision = ?
						WHERE record_id = ?`,
				[captured.revision, row.record_id],
			);
		});
	}

	return {
		appendLocal(address: RecordAddress, update: Uint8Array): void {
			append(address, update, 'local');
		},
		installAccepted(address: RecordAddress, update: Uint8Array): void {
			append(address, update, 'accepted');
		},
		inspect,
		exportDocument,
		publication,
		settle,
		measure(address: RecordAddress) {
			const encoded = exportDocument(address);
			return encoded === undefined ? undefined : measureDocumentState(encoded);
		},
		bound: DOCUMENT_BOUND,
	};
}

export type ReplicaDocumentStore = ReturnType<
	typeof createReplicaDocumentStore
>;
