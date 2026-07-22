import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import {
	DOCUMENT_BOUND,
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
	doc_id: number | null;
	confirmed_state: 'live' | 'tombstone' | 'unset' | null;
	sealed_op: 'patch' | 'replace' | 'tombstone' | 'unset' | null;
	pending_op: 'patch' | 'replace' | 'tombstone' | 'unset' | null;
	revision: number | null;
	dirty: number | null;
};

type ChainRow = SqliteRow & {
	seq: number;
	kind: 'baseline' | 'update';
	bytes: Uint8Array | ArrayBuffer;
};

type InflightRow = SqliteRow & {
	payload: Uint8Array | ArrayBuffer | null;
	digest: string;
	captured_revision: number;
	parked_code: 'document-bound' | null;
	measured_bytes: number | null;
	measured_structs: number | null;
	limit_bytes: number | null;
	limit_structs: number | null;
};

export type DocumentInspection = {
	revision: number;
	chainBytes: number;
	dirty: boolean;
	inflight: 'none' | 'active' | 'parked';
};

export type FrozenDocumentPublication = DocumentPublicationRequest & {
	capturedRevision: number;
};

export type DocumentPublicationState =
	| { kind: 'clean' }
	| { kind: 'ready'; publication: FrozenDocumentPublication }
	| { kind: 'parked'; refusal: DocumentBoundRefusal };

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
		`WITH address AS (
			SELECT namespace, collection, record_key FROM confirmed_records
			WHERE ${TRIPLE_WHERE}
			UNION
			SELECT namespace, collection, record_key FROM local_intents
			WHERE ${TRIPLE_WHERE}
			UNION
			SELECT namespace, collection, record_key FROM record_documents
			WHERE ${TRIPLE_WHERE}
		)
		SELECT d.doc_id, c.state AS confirmed_state,
			i.sealed_op, i.pending_op, d.revision, d.dirty
		FROM address a
		LEFT JOIN confirmed_records c USING (namespace, collection, record_key)
		LEFT JOIN local_intents i USING (namespace, collection, record_key)
		LEFT JOIN record_documents d USING (namespace, collection, record_key)`,
		[
			...tripleParams(address),
			...tripleParams(address),
			...tripleParams(address),
		],
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
	if (!isVisibleLive) throw new Error('document record is not live');
	return row;
}

function chainFor(database: SqliteDatabase, docId: number): ChainRow[] {
	return database.all<ChainRow>(
		`SELECT seq, kind, bytes FROM document_chains
		WHERE doc_id = ? ORDER BY seq`,
		[docId],
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

function inflightFor(
	database: SqliteDatabase,
	docId: number,
): InflightRow | null {
	return one<InflightRow>(
		database,
		'SELECT * FROM document_inflight WHERE doc_id = ?',
		[docId],
	);
}

function publicationFrom(
	address: RecordAddress,
	authorityLifetime: string,
	inflight: InflightRow,
): FrozenDocumentPublication {
	if (inflight.payload === null) {
		throw new Error('active document publication has no payload');
	}
	return {
		authorityLifetime,
		address: structuredClone(address),
		protocolVersion: DOCUMENT_PUBLICATION_VERSION,
		payload: copyBytes(inflight.payload),
		digest: inflight.digest,
		capturedRevision: inflight.captured_revision,
	};
}

function receiptFrom(
	address: RecordAddress,
	authorityLifetime: string,
	digest: string,
): DocumentPublicationReceipt {
	return {
		authorityLifetime,
		address: structuredClone(address),
		protocolVersion: DOCUMENT_PUBLICATION_VERSION,
		digest,
	};
}

/** Record-owned bounded document chains and exact publication retry evidence. */
export function createSplitReplicaDocumentStore(
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
			const chain = row.doc_id === null ? [] : chainFor(database, row.doc_id);
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
				let docId = row.doc_id;
				if (docId === null) {
					database.run(
						`INSERT INTO record_documents (
							namespace, collection, record_key
						) VALUES (?, ?, ?)`,
						tripleParams(address),
					);
					docId = one<SqliteRow & { doc_id: number }>(
						database,
						`SELECT doc_id FROM record_documents WHERE ${TRIPLE_WHERE}`,
						tripleParams(address),
					)?.doc_id ?? null;
					if (docId === null) throw new Error('document record is absent');
				}
				if (compact) {
					const baseline = after;
					database.run('DELETE FROM document_chains WHERE doc_id = ?', [
						docId,
					]);
					database.run(
						`INSERT INTO document_chains (doc_id, seq, kind, bytes)
						VALUES (?, 1, 'baseline', ?)`,
						[docId, baseline],
					);
				} else {
					const nextSequence = chain.at(-1)?.seq ?? 0;
					database.run(
						`INSERT INTO document_chains (doc_id, seq, kind, bytes)
						VALUES (?, ?, 'update', ?)`,
						[docId, nextSequence + 1, ownedUpdate],
					);
				}
				if (kind === 'local') {
					if ((row.revision ?? 0) === Number.MAX_SAFE_INTEGER) {
						throw new Error('document revision space is exhausted');
					}
					database.run(
						`UPDATE record_documents SET revision = revision + 1, dirty = 1
						WHERE doc_id = ?`,
						[docId],
					);
					// A new revision supersedes a parked retry image. An active image
					// remains immutable until its exact receipt arrives.
					database.run(
						`DELETE FROM document_inflight
						WHERE doc_id = ? AND parked_code IS NOT NULL`,
						[docId],
					);
				} else {
					// Accepted downstream state can make a formerly full join admissible.
					database.run(
						`DELETE FROM document_inflight
						WHERE doc_id = ? AND parked_code IS NOT NULL`,
						[docId],
					);
				}
			} finally {
				document.destroy();
			}
		});
	}

	function inspect(address: RecordAddress): DocumentInspection | null {
		const row = rowFor(database, address);
		if (row === null || row.doc_id === null) return null;
		const aggregate = one<SqliteRow & { entries: number; bytes: number }>(
			database,
			`SELECT count(*) AS entries, COALESCE(sum(length(bytes)), 0) AS bytes
			FROM document_chains WHERE doc_id = ?`,
			[row.doc_id],
		);
		if ((aggregate?.entries ?? 0) === 0) return null;
		const inflight = inflightFor(database, row.doc_id);
		return {
			revision: row.revision ?? 0,
			chainBytes: aggregate?.bytes ?? 0,
			dirty: row.dirty === 1,
			inflight:
				inflight === null
					? 'none'
					: inflight.parked_code === null
						? 'active'
						: 'parked',
		};
	}

	function exportDocument(address: RecordAddress): Uint8Array | undefined {
		const row = rowFor(database, address);
		if (row === null || row.doc_id === null) return undefined;
		const chain = chainFor(database, row.doc_id);
		if (chain.length === 0) return undefined;
		const document = hydrate(chain);
		try {
			return new Uint8Array(Y.encodeStateAsUpdateV2(document));
		} finally {
			document.destroy();
		}
	}

	function publication(
		address: RecordAddress,
		authorityStateVector?: Uint8Array,
	): DocumentPublicationState {
		return database.transaction(() => {
			const row = requireDocumentOwner(database, address);
			if (row.doc_id === null || row.dirty === 0) return { kind: 'clean' };
			const meta = one<SqliteRow & { authority_lifetime: string | null }>(
				database,
				'SELECT authority_lifetime FROM meta WHERE singleton = 1',
			);
			if (meta?.authority_lifetime === null || meta === null) {
				throw new Error('cannot freeze a document before lifetime binding');
			}
			const existing = inflightFor(database, row.doc_id);
			if (existing !== null) {
				if (existing.parked_code === 'document-bound') {
					if (
						existing.measured_bytes === null ||
						existing.measured_structs === null ||
						existing.limit_bytes === null ||
						existing.limit_structs === null
					) {
						throw new Error('parked document publication is corrupt');
					}
					return {
						kind: 'parked',
						refusal: {
							...receiptFrom(address, meta.authority_lifetime, existing.digest),
							kind: 'document-bound',
							measured: {
								stateBytes: existing.measured_bytes,
								stateStructs: existing.measured_structs,
							},
							limit: {
								stateBytes: existing.limit_bytes,
								stateStructs: existing.limit_structs,
							},
						},
					};
				}
				return {
					kind: 'ready',
					publication: publicationFrom(
						address,
						meta.authority_lifetime,
						existing,
					),
				};
			}
			const chain = chainFor(database, row.doc_id);
			if (chain.length === 0) {
				throw new Error('dirty document has no persisted chain');
			}
			const document = hydrate(chain);
			try {
				const encodedState = new Uint8Array(Y.encodeStateAsUpdateV2(document));
				const measured = measureDocumentState(encodedState);
				if (exceedsDocumentBound(measured)) {
					const digest = documentPayloadDigest(encodedState);
					database.run(
						`INSERT INTO document_inflight (
							doc_id, payload, digest, captured_revision, parked_code,
							measured_bytes, measured_structs, limit_bytes, limit_structs
						) VALUES (?, NULL, ?, ?, 'document-bound', ?, ?, ?, ?)`,
						[
							row.doc_id,
							digest,
							row.revision ?? 0,
							measured.stateBytes,
							measured.stateStructs,
							DOCUMENT_BOUND.stateBytes,
							DOCUMENT_BOUND.stateStructs,
						],
					);
					return {
						kind: 'parked',
						refusal: {
							...receiptFrom(address, meta.authority_lifetime, digest),
							kind: 'document-bound',
							measured,
							limit: DOCUMENT_BOUND,
						},
					};
				}
				const payload = new Uint8Array(
					Y.encodeStateAsUpdateV2(document, authorityStateVector),
				);
				const digest = documentPayloadDigest(payload);
				database.run(
						`INSERT INTO document_inflight (
							doc_id, payload, digest, captured_revision
						) VALUES (?, ?, ?, ?)`,
						[row.doc_id, payload, digest, row.revision ?? 0],
				);
				return {
					kind: 'ready',
					publication: {
						authorityLifetime: meta.authority_lifetime,
						address: structuredClone(address),
						protocolVersion: DOCUMENT_PUBLICATION_VERSION,
						payload,
						digest,
						capturedRevision: row.revision ?? 0,
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
			const meta = one<SqliteRow & { authority_lifetime: string | null }>(
				database,
				'SELECT authority_lifetime FROM meta WHERE singleton = 1',
			);
			if (meta?.authority_lifetime !== proof.authorityLifetime) {
				throw new Error('document publication proof lifetime mismatch');
			}
			const row = requireDocumentOwner(database, address);
			const inflight =
				row.doc_id === null ? null : inflightFor(database, row.doc_id);
			if (inflight === null || inflight.digest !== proof.digest) {
				throw new Error('document publication proof does not match inflight');
			}
			if ('kind' in proof) {
				if (row.revision !== inflight.captured_revision) {
					database.run('DELETE FROM document_inflight WHERE doc_id = ?', [
						row.doc_id,
					]);
					return;
				}
				database.run(
					`UPDATE document_inflight SET
						payload = NULL,
						parked_code = 'document-bound',
						measured_bytes = ?, measured_structs = ?,
						limit_bytes = ?, limit_structs = ?
					WHERE doc_id = ?`,
					[
						proof.measured.stateBytes,
						proof.measured.stateStructs,
						proof.limit.stateBytes,
						proof.limit.stateStructs,
						row.doc_id,
					],
				);
				return;
			}
			database.run('DELETE FROM document_inflight WHERE doc_id = ?', [
				row.doc_id,
			]);
			if (row.revision === inflight.captured_revision) {
				database.run('UPDATE record_documents SET dirty = 0 WHERE doc_id = ?', [
					row.doc_id,
				]);
			}
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

export type SplitReplicaDocumentStore = ReturnType<
	typeof createSplitReplicaDocumentStore
>;
