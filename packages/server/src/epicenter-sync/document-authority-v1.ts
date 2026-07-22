import {
	DOCUMENT_PUBLICATION_VERSION,
	type DocumentAcceptance,
	type DocumentPublicationReceipt,
	type DocumentPublicationRequest,
	documentPayloadDigest,
} from '@epicenter/data/document-v1';
import type { RecordAddress } from '@epicenter/data/protocol/v1';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import {
	DOCUMENT_BOUND,
	exceedsDocumentBound,
	measureDocumentState,
} from '@epicenter/sync/document-v3';
import * as Y from '@y/y';

const TRIPLE_WHERE = 'namespace = ? AND collection = ? AND record_key = ?';
const hydrationOrigin = Symbol('epicenter-authority-document-hydration');

export const AUTHORITY_DOCUMENT_CHAIN_LIMITS = {
	tailEntries: 64,
	tailBytes: 1_048_576,
} as const;

type RecordRow = SqliteRow & {
	record_id: number;
	state: 'live' | 'tombstone' | 'unset';
};

type MetaRow = SqliteRow & {
	authority_lifetime: string;
	next_capture_revision: number;
};

type ChainRow = SqliteRow & {
	seq: number;
	kind: 'baseline' | 'update';
	bytes: Uint8Array | ArrayBuffer;
};

export type AuthorityDocumentRead =
	| { state: 'absent' }
	| {
			state: 'live' | 'tombstone' | 'unset';
			update: Uint8Array | undefined;
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

function copyBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
	return value instanceof Uint8Array
		? new Uint8Array(value)
		: new Uint8Array(value.slice(0));
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

function receiptFor(
	request: DocumentPublicationRequest,
): DocumentPublicationReceipt {
	return {
		authorityLifetime: request.authorityLifetime,
		address: structuredClone(request.address),
		protocolVersion: DOCUMENT_PUBLICATION_VERSION,
		digest: request.digest,
	};
}

/** Bounded document joiner inside the principal-owned authority database. */
export function createAuthorityDocumentV1(database: SqliteDatabase) {
	function accept(request: DocumentPublicationRequest): DocumentAcceptance {
		if (
			request.protocolVersion !== DOCUMENT_PUBLICATION_VERSION ||
			!(request.payload instanceof Uint8Array) ||
			request.payload.byteLength === 0 ||
			documentPayloadDigest(request.payload) !== request.digest
		) {
			throw new TypeError('invalid document publication request');
		}
		const payload = new Uint8Array(request.payload);
		return database.transaction(() => {
			const meta = one<MetaRow>(
				database,
				`SELECT authority_lifetime, next_capture_revision
				FROM meta WHERE singleton = 1`,
			);
			if (meta === null) throw new Error('authority metadata is missing');
			if (request.authorityLifetime !== meta.authority_lifetime) {
				return {
					kind: 'lifetime-mismatch',
					activeAuthorityLifetime: meta.authority_lifetime,
				};
			}
			const row = one<RecordRow>(
				database,
				`SELECT record_id, state FROM records WHERE ${TRIPLE_WHERE}`,
				tripleParams(request.address),
			);
			if (row === null) {
				return {
					kind: 'record-not-live',
					activeAuthorityLifetime: meta.authority_lifetime,
					address: structuredClone(request.address),
					state: 'absent',
				};
			}
			if (row.state !== 'live') {
				return {
					kind: 'record-not-live',
					activeAuthorityLifetime: meta.authority_lifetime,
					address: structuredClone(request.address),
					state: row.state,
				};
			}

			const chain = chainFor(database, row.record_id);
			const document = hydrate(chain);
			try {
				const before = new Uint8Array(Y.encodeStateAsUpdateV2(document));
				Y.applyUpdateV2(document, payload, hydrationOrigin);
				const after = new Uint8Array(Y.encodeStateAsUpdateV2(document));
				const measured = measureDocumentState(after);
				if (exceedsDocumentBound(measured)) {
					return {
						...receiptFor(request),
						kind: 'document-bound',
						measured,
						limit: DOCUMENT_BOUND,
					};
				}

				const changed =
					before.byteLength !== after.byteLength ||
					before.some((byte, index) => byte !== after[index]);
				if (changed) {
					if (!Number.isSafeInteger(meta.next_capture_revision)) {
						throw new Error('authority capture revision exhausted');
					}
					const tail = chain.filter((entry) => entry.kind === 'update');
					const tailBytes = tail.reduce(
						(total, entry) => total + copyBytes(entry.bytes).byteLength,
						0,
					);
					const compact =
						tail.length + 1 > AUTHORITY_DOCUMENT_CHAIN_LIMITS.tailEntries ||
						tailBytes + payload.byteLength >
							AUTHORITY_DOCUMENT_CHAIN_LIMITS.tailBytes;
					if (compact) {
						database.run('DELETE FROM record_documents WHERE record_id = ?', [
							row.record_id,
						]);
						database.run(
							`INSERT INTO record_documents (record_id, seq, kind, bytes)
							VALUES (?, 1, 'baseline', ?)`,
							[row.record_id, after],
						);
					} else {
						database.run(
							`INSERT INTO record_documents (record_id, seq, kind, bytes)
							VALUES (?, ?, 'update', ?)`,
							[row.record_id, (chain.at(-1)?.seq ?? 0) + 1, payload],
						);
					}
					database.run(
						'UPDATE records SET capture_revision = ? WHERE record_id = ?',
						[meta.next_capture_revision, row.record_id],
					);
					database.run(
						`UPDATE meta SET next_capture_revision = ? WHERE singleton = 1`,
						[meta.next_capture_revision + 1],
					);
				}
				return { kind: 'accepted', receipt: receiptFor(request) };
			} finally {
				document.destroy();
			}
		});
	}

	function exportDocument(address: RecordAddress): Uint8Array | undefined {
		return database.transaction(() => {
			const row = one<RecordRow>(
				database,
				`SELECT record_id, state FROM records WHERE ${TRIPLE_WHERE}`,
				tripleParams(address),
			);
			if (row === null) return undefined;
			const chain = chainFor(database, row.record_id);
			if (chain.length === 0) return undefined;
			const document = hydrate(chain);
			try {
				return new Uint8Array(Y.encodeStateAsUpdateV2(document));
			} finally {
				document.destroy();
			}
		});
	}

	function readDocument(address: RecordAddress): AuthorityDocumentRead {
		return database.transaction(() => {
			const row = one<RecordRow>(
				database,
				`SELECT record_id, state FROM records WHERE ${TRIPLE_WHERE}`,
				tripleParams(address),
			);
			if (row === null) return { state: 'absent' };
			const chain = chainFor(database, row.record_id);
			if (chain.length === 0) return { state: row.state, update: undefined };
			const document = hydrate(chain);
			try {
				return {
					state: row.state,
					update: new Uint8Array(Y.encodeStateAsUpdateV2(document)),
				};
			} finally {
				document.destroy();
			}
		});
	}

	return { accept, exportDocument, readDocument };
}

export type AuthorityDocumentV1 = ReturnType<typeof createAuthorityDocumentV1>;
