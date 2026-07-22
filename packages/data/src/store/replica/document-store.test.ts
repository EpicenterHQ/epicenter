import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { DOCUMENT_BOUND } from '@epicenter/sync/document-v3';
import * as Y from '@y/y';

import type {
	DocumentBoundRefusal,
	DocumentPublicationReceipt,
} from '../../document-v1/index.js';
import type { RecordAddress } from '../../protocol/v1/index.js';
import { makeLimits } from '../../protocol/v1/kernel.test-support.js';
import { openReplicaStore } from './replica-store.js';

const ADDRESS: RecordAddress = {
	namespace: 'so.epicenter.notes',
	collection: 'records',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};

function setup() {
	const database = new Database(':memory:', { strict: true });
	const store = openReplicaStore({
		database: createBunSqliteAdapter(database),
		limits: makeLimits(),
		initialize: {
			replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
			authorityLifetime: 'lifetime-one',
		},
	});
	store.localWrite({ address: ADDRESS, op: 'replace', value: { title: 'x' } });
	return { database, store };
}

function sourceUpdates(...values: string[]): Uint8Array[] {
	const document = new Y.Doc({ gc: true });
	const updates: Uint8Array[] = [];
	document.on('updateV2', (update: Uint8Array) => {
		updates.push(new Uint8Array(update));
	});
	for (const value of values) document.get('content').insert(0, value);
	document.destroy();
	return updates;
}

function documentText(update: Uint8Array): string {
	const document = new Y.Doc({ gc: true });
	try {
		Y.applyUpdateV2(document, update);
		return document.get('content').toString();
	} finally {
		document.destroy();
	}
}

function receipt(
	publication: Extract<
		ReturnType<ReturnType<typeof openReplicaStore>['documentPublication']>,
		{ kind: 'ready' }
	>['publication'],
): DocumentPublicationReceipt {
	return {
		authorityLifetime: publication.authorityLifetime,
		address: publication.address,
		protocolVersion: publication.protocolVersion,
		digest: publication.digest,
	};
}

describe('record document store', () => {
	test('persists local updates, revision, dirty state, and self-contained export', () => {
		const context = setup();
		try {
			const [update] = sourceUpdates('hello');
			if (update === undefined) throw new Error('missing source update');
			context.store.appendLocalDocumentUpdate(ADDRESS, update);

			expect(context.store.inspectDocument(ADDRESS)).toMatchObject({
				revision: 1,
				dirty: true,
				inflight: 'none',
			});
			const exported = context.store.exportDocument(ADDRESS);
			if (exported === undefined) throw new Error('document was not exported');
			expect(documentText(exported)).toBe('hello');
			expect(context.store.measureDocument(ADDRESS)?.stateBytes).toBe(
				exported.byteLength,
			);
		} finally {
			context.database.close();
		}
	});

	test('compacts a tail over the entry threshold without changing state', () => {
		const context = setup();
		try {
			const values = Array.from({ length: 65 }, (_, index) =>
				String.fromCharCode(65 + (index % 26)),
			);
			for (const update of sourceUpdates(...values)) {
				context.store.appendLocalDocumentUpdate(ADDRESS, update);
			}
			const chain = context.database
				.query<{ kind: string; entries: number }, []>(
					`SELECT kind, count(*) AS entries FROM record_documents
					GROUP BY kind`,
				)
				.all();
			expect(chain).toEqual([{ kind: 'baseline', entries: 1 }]);
			const exported = context.store.exportDocument(ADDRESS);
			if (exported === undefined) throw new Error('document was not exported');
			expect(documentText(exported)).toBe(values.toReversed().join(''));
		} finally {
			context.database.close();
		}
	});

	test('duplicate and dependency-reordered updates converge without duplicate storage', () => {
		const context = setup();
		try {
			const [first, second] = sourceUpdates('a', 'b');
			if (first === undefined || second === undefined) {
				throw new Error('missing source updates');
			}
			context.store.installAcceptedDocumentUpdate(ADDRESS, second);
			context.store.installAcceptedDocumentUpdate(ADDRESS, first);
			context.store.installAcceptedDocumentUpdate(ADDRESS, second);
			const exported = context.store.exportDocument(ADDRESS);
			if (exported === undefined) throw new Error('document was not exported');
			expect(documentText(exported)).toBe('ba');
			expect(context.store.inspectDocument(ADDRESS)?.dirty).toBe(false);
			expect(
				context.database
					.query<{ count: number }, []>(
						'SELECT count(*) AS count FROM record_documents',
					)
					.get()?.count,
			).toBe(2);
		} finally {
			context.database.close();
		}
	});

	test('freezes one exact retry image and an older receipt cannot clean a newer revision', () => {
		const context = setup();
		try {
			const [first, second] = sourceUpdates('a', 'b');
			if (first === undefined || second === undefined) {
				throw new Error('missing source updates');
			}
			context.store.appendLocalDocumentUpdate(ADDRESS, first);
			const frozen = context.store.documentPublication(ADDRESS);
			if (frozen.kind !== 'ready') throw new Error('publication was not ready');
			const retry = context.store.documentPublication(ADDRESS);
			expect(retry).toEqual(frozen);

			context.store.appendLocalDocumentUpdate(ADDRESS, second);
			expect(context.store.documentPublication(ADDRESS)).toEqual(frozen);
			context.store.settleDocumentPublication(
				ADDRESS,
				receipt(frozen.publication),
			);
			expect(context.store.inspectDocument(ADDRESS)).toMatchObject({
				revision: 2,
				dirty: true,
				inflight: 'none',
			});

			const newer = context.store.documentPublication(ADDRESS);
			if (newer.kind !== 'ready')
				throw new Error('newer publication not ready');
			expect(newer.publication.digest).not.toBe(frozen.publication.digest);
			context.store.settleDocumentPublication(
				ADDRESS,
				receipt(newer.publication),
			);
			expect(context.store.inspectDocument(ADDRESS)?.dirty).toBe(false);
		} finally {
			context.database.close();
		}
	});

	test('persists a bound refusal and a newer local edit supersedes it', () => {
		const context = setup();
		try {
			const [first, second] = sourceUpdates('a', 'b');
			if (first === undefined || second === undefined) {
				throw new Error('missing source updates');
			}
			context.store.appendLocalDocumentUpdate(ADDRESS, first);
			const frozen = context.store.documentPublication(ADDRESS);
			if (frozen.kind !== 'ready') throw new Error('publication was not ready');
			const refusal: DocumentBoundRefusal = {
				...receipt(frozen.publication),
				kind: 'document-bound',
				measured: {
					stateBytes: DOCUMENT_BOUND.stateBytes + 1,
					stateStructs: DOCUMENT_BOUND.stateStructs,
				},
				limit: DOCUMENT_BOUND,
			};
			context.store.settleDocumentPublication(ADDRESS, refusal);
			expect(context.store.documentPublication(ADDRESS)).toEqual({
				kind: 'parked',
				refusal,
			});
			expect(
				openReplicaStore({
					database: createBunSqliteAdapter(context.database),
					limits: makeLimits(),
				}).documentPublication(ADDRESS),
			).toEqual({ kind: 'parked', refusal });

			context.store.appendLocalDocumentUpdate(ADDRESS, second);
			expect(context.store.inspectDocument(ADDRESS)?.inflight).toBe('none');
			expect(context.store.documentPublication(ADDRESS).kind).toBe('ready');
		} finally {
			context.database.close();
		}
	});

	test('parks record-not-live and a new live scalar desire makes it eligible', () => {
		const context = setup();
		try {
			const [update] = sourceUpdates('hello');
			if (update === undefined) throw new Error('missing source update');
			context.store.appendLocalDocumentUpdate(ADDRESS, update);
			const frozen = context.store.documentPublication(ADDRESS);
			if (frozen.kind !== 'ready') throw new Error('publication was not ready');
			const refusal = {
				kind: 'record-not-live',
				activeAuthorityLifetime: 'lifetime-one',
				address: ADDRESS,
				state: 'unset',
			} as const;
			context.store.settleDocumentPublication(ADDRESS, refusal);
			expect(context.store.documentPublication(ADDRESS)).toEqual({
				kind: 'parked',
				refusal,
			});
			expect(context.store.parkedWork()).toMatchObject({
				entries: [
					{
						address: ADDRESS,
						document: { code: 'record-not-live', state: 'unset' },
					},
				],
			});

			context.store.localWrite({
				address: ADDRESS,
				op: 'patch',
				set: { title: 'local' },
				unset: [],
			});
			expect(context.store.inspectDocument(ADDRESS)?.inflight).toBe('none');
			expect(context.store.documentPublication(ADDRESS).kind).toBe('ready');

			context.store.settleDocumentPublication(ADDRESS, refusal);
			context.store.installFacts({
				request: { authorityLifetime: 'lifetime-one', afterSequence: 0 },
				response: {
					authorityLifetime: 'lifetime-one',
					facts: [
						{
							address: ADDRESS,
							sequence: 1,
							state: 'live',
							payload: { title: 'remote' },
						},
					],
					hasMore: false,
				},
			});
			expect(context.store.inspectDocument(ADDRESS)?.inflight).toBe('none');
		} finally {
			context.database.close();
		}
	});

	test('parks an over-bound local state without duplicating its payload', () => {
		const context = setup();
		try {
			const [update] = sourceUpdates('x'.repeat(DOCUMENT_BOUND.stateBytes + 1));
			if (update === undefined) throw new Error('missing source update');
			context.store.appendLocalDocumentUpdate(ADDRESS, update);
			const publication = context.store.documentPublication(ADDRESS);
			expect(publication.kind).toBe('parked');
			if (publication.kind !== 'parked') {
				throw new Error('over-bound document was not parked');
			}
			if (publication.refusal.kind !== 'document-bound') {
				throw new Error('over-bound document has the wrong refusal');
			}
			expect(publication.refusal.measured.stateBytes).toBeGreaterThan(
				DOCUMENT_BOUND.stateBytes,
			);
			expect(
				context.database
					.query<{ payload: Uint8Array | null }, []>(
						'SELECT payload FROM document_inflight',
					)
					.get()?.payload,
			).toBeNull();
		} finally {
			context.database.close();
		}
	});

	test('invalid or mismatched updates and proofs leave committed state unchanged', () => {
		const context = setup();
		try {
			const [update] = sourceUpdates('a');
			if (update === undefined) throw new Error('missing source update');
			context.store.appendLocalDocumentUpdate(ADDRESS, update);
			const beforeInvalid = context.store.exportDocument(ADDRESS);
			expect(() =>
				context.store.appendLocalDocumentUpdate(ADDRESS, new Uint8Array([1])),
			).toThrow();
			expect(context.store.exportDocument(ADDRESS)).toEqual(beforeInvalid);

			const frozen = context.store.documentPublication(ADDRESS);
			if (frozen.kind !== 'ready') throw new Error('publication was not ready');
			const beforeProof = context.store.documentPublication(ADDRESS);
			expect(() =>
				context.store.settleDocumentPublication(ADDRESS, {
					...receipt(frozen.publication),
					digest: 'f'.repeat(64),
				}),
			).toThrow(/does not match inflight/);
			expect(context.store.documentPublication(ADDRESS)).toEqual(beforeProof);
		} finally {
			context.database.close();
		}
	});

	test('unset preserves the chain while local tombstone reaps it atomically', () => {
		const context = setup();
		try {
			const [update, updateWhileUnset] = sourceUpdates('a', 'b');
			if (update === undefined || updateWhileUnset === undefined) {
				throw new Error('missing source update');
			}
			context.store.appendLocalDocumentUpdate(ADDRESS, update);
			context.store.documentPublication(ADDRESS);

			context.store.localWrite({ address: ADDRESS, op: 'unset' });
			expect(context.store.exportDocument(ADDRESS)).toBeDefined();
			context.store.appendLocalDocumentUpdate(ADDRESS, updateWhileUnset);
			expect(context.store.inspectDocument(ADDRESS)).toMatchObject({
				revision: 2,
				dirty: true,
			});

			context.store.localWrite({ address: ADDRESS, op: 'replace', value: {} });
			context.store.localWrite({ address: ADDRESS, op: 'tombstone' });
			expect(context.store.exportDocument(ADDRESS)).toBeUndefined();
			expect(context.store.inspectDocument(ADDRESS)).toBeNull();
			expect(
				context.database
					.query<{ count: number }, []>(
						'SELECT count(*) AS count FROM document_inflight',
					)
					.get()?.count,
			).toBe(0);
		} finally {
			context.database.close();
		}
	});
});
