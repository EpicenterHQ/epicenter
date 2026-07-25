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
import type { CapturedDocumentPublication } from './document-store.js';
import { openReplicaStore } from './replica-store.js';

const ADDRESS: RecordAddress = {
	namespace: 'so.epicenter.notes',
	collection: 'records',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};

function setup() {
	const database = new Database(':memory:', { strict: true });
	const store = openReplicaStore({
		owner: null,
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
	publication: CapturedDocumentPublication,
): DocumentPublicationReceipt {
	return {
		authorityLifetime: publication.authorityLifetime,
		address: publication.address,
		protocolVersion: publication.protocolVersion,
		digest: publication.digest,
	};
}

function capturedOf(publication: CapturedDocumentPublication): {
	revision: number;
	digest: string;
} {
	return { revision: publication.capturedRevision, digest: publication.digest };
}

describe('record document store', () => {
	test('persists local updates, watermarks, and self-contained export', () => {
		const context = setup();
		try {
			const [update] = sourceUpdates('hello');
			if (update === undefined) throw new Error('missing source update');
			context.store.appendLocalDocumentUpdate(ADDRESS, update);

			expect(context.store.inspectDocument(ADDRESS)).toMatchObject({
				revision: 1,
				acceptedRevision: 0,
				owed: true,
				refusedRevision: null,
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

	test('duplicate and dependency-reordered installs converge without a local obligation', () => {
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
			expect(context.store.inspectDocument(ADDRESS)).toMatchObject({
				revision: 0,
				acceptedRevision: 0,
				owed: false,
			});
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

	test('publication regenerates from durable state and a delayed receipt cannot settle newer work', () => {
		const context = setup();
		try {
			const [first, second] = sourceUpdates('a', 'b');
			if (first === undefined || second === undefined) {
				throw new Error('missing source updates');
			}
			context.store.appendLocalDocumentUpdate(ADDRESS, first);
			const attempt = context.store.documentPublication(ADDRESS);
			if (attempt.kind !== 'ready') throw new Error('publication not ready');
			// A lost reply regenerates the same attempt from durable state.
			const regenerated = context.store.documentPublication(ADDRESS);
			expect(regenerated).toEqual(attempt);

			context.store.appendLocalDocumentUpdate(ADDRESS, second);
			// The delayed receipt for revision 1 advances only to revision 1: the
			// racing edit at revision 2 remains owed.
			context.store.settleDocumentPublication(
				ADDRESS,
				receipt(attempt.publication),
				capturedOf(attempt.publication),
			);
			expect(context.store.inspectDocument(ADDRESS)).toMatchObject({
				revision: 2,
				acceptedRevision: 1,
				owed: true,
			});

			const newer = context.store.documentPublication(ADDRESS);
			if (newer.kind !== 'ready')
				throw new Error('newer publication not ready');
			expect(newer.publication.capturedRevision).toBe(2);
			context.store.settleDocumentPublication(
				ADDRESS,
				receipt(newer.publication),
				capturedOf(newer.publication),
			);
			expect(context.store.inspectDocument(ADDRESS)).toMatchObject({
				revision: 2,
				acceptedRevision: 2,
				owed: false,
			});

			// A duplicate of the older receipt is a no-op, never a regression.
			context.store.settleDocumentPublication(
				ADDRESS,
				receipt(attempt.publication),
				capturedOf(attempt.publication),
			);
			expect(context.store.inspectDocument(ADDRESS)?.acceptedRevision).toBe(2);
		} finally {
			context.database.close();
		}
	});

	test('a delete-only update stays owed and publishes as complete state', () => {
		const context = setup();
		try {
			const source = new Y.Doc({ gc: true });
			const updates: Uint8Array[] = [];
			source.on('updateV2', (update: Uint8Array) => {
				updates.push(new Uint8Array(update));
			});
			source.get('content').insert(0, 'ab');
			source.get('content').delete(0, 1);
			source.destroy();
			const [insert, deletion] = updates;
			if (insert === undefined || deletion === undefined) {
				throw new Error('missing source updates');
			}
			context.store.appendLocalDocumentUpdate(ADDRESS, insert);
			const first = context.store.documentPublication(ADDRESS);
			if (first.kind !== 'ready') throw new Error('publication not ready');
			context.store.settleDocumentPublication(
				ADDRESS,
				receipt(first.publication),
				capturedOf(first.publication),
			);

			context.store.appendLocalDocumentUpdate(ADDRESS, deletion);
			expect(context.store.inspectDocument(ADDRESS)?.owed).toBe(true);
			const deleteOnly = context.store.documentPublication(ADDRESS);
			if (deleteOnly.kind !== 'ready') {
				throw new Error('delete-only publication was not ready');
			}
			expect(deleteOnly.publication.payload.byteLength).toBeGreaterThan(0);
			context.store.settleDocumentPublication(
				ADDRESS,
				receipt(deleteOnly.publication),
				capturedOf(deleteOnly.publication),
			);
			expect(context.store.inspectDocument(ADDRESS)?.owed).toBe(false);
		} finally {
			context.database.close();
		}
	});

	test('keeps authority refusal evidence diagnostic while retry stays eligible', () => {
		const context = setup();
		try {
			const [first, second] = sourceUpdates('a', 'b');
			if (first === undefined || second === undefined) {
				throw new Error('missing source updates');
			}
			context.store.appendLocalDocumentUpdate(ADDRESS, first);
			const attempt = context.store.documentPublication(ADDRESS);
			if (attempt.kind !== 'ready') throw new Error('publication not ready');
			const refusal: DocumentBoundRefusal = {
				...receipt(attempt.publication),
				kind: 'document-bound',
				measured: {
					stateBytes: DOCUMENT_BOUND.stateBytes + 1,
					stateStructs: DOCUMENT_BOUND.stateStructs,
				},
				limit: DOCUMENT_BOUND,
			};
			context.store.settleDocumentPublication(
				ADDRESS,
				refusal,
				capturedOf(attempt.publication),
			);
			expect(
				context.store.inspectDocument(ADDRESS)?.refusedRevision,
			).not.toBeNull();
			const retry = context.store.documentPublication(ADDRESS);
			if (retry.kind !== 'ready')
				throw new Error('refused revision cannot retry');
			expect(retry.publication.digest).toBe(attempt.publication.digest);
			// The refusal evidence is durable across a clean reopen.
			const reopened = openReplicaStore({
				owner: null,
				database: createBunSqliteAdapter(context.database),
				limits: makeLimits(),
			});
			expect(reopened.inspectDocument(ADDRESS)?.refusedRevision).not.toBeNull();
			expect(reopened.documentPublication(ADDRESS).kind).toBe('ready');

			context.store.appendLocalDocumentUpdate(ADDRESS, second);
			expect(
				context.store.inspectDocument(ADDRESS)?.refusedRevision,
			).toBeNull();
			expect(context.store.documentPublication(ADDRESS).kind).toBe('ready');
		} finally {
			context.database.close();
		}
	});

	test('a remote install invalidates a delayed refusal for the same local revision', () => {
		const context = setup();
		try {
			const [local, remote] = sourceUpdates('local', 'remote');
			if (local === undefined || remote === undefined) {
				throw new Error('missing source updates');
			}
			context.store.appendLocalDocumentUpdate(ADDRESS, local);
			const attempt = context.store.documentPublication(ADDRESS);
			if (attempt.kind !== 'ready') throw new Error('publication not ready');

			context.store.installAcceptedDocumentUpdate(ADDRESS, remote);
			context.store.settleDocumentPublication(
				ADDRESS,
				{
					...receipt(attempt.publication),
					kind: 'document-bound',
					measured: {
						stateBytes: DOCUMENT_BOUND.stateBytes + 1,
						stateStructs: DOCUMENT_BOUND.stateStructs,
					},
					limit: DOCUMENT_BOUND,
				},
				capturedOf(attempt.publication),
			);

			expect(context.store.inspectDocument(ADDRESS)).toMatchObject({
				revision: 1,
				owed: true,
				refusedRevision: null,
			});
			expect(context.store.documentPublication(ADDRESS).kind).toBe('ready');
		} finally {
			context.database.close();
		}
	});

	test('an accepted inbound install does not re-arm a refused local revision', () => {
		const context = setup();
		try {
			const [local, remote] = sourceUpdates('local', 'remote');
			if (local === undefined || remote === undefined) {
				throw new Error('missing source updates');
			}
			context.store.appendLocalDocumentUpdate(ADDRESS, local);
			const attempt = context.store.documentPublication(ADDRESS);
			if (attempt.kind !== 'ready') throw new Error('publication not ready');
			context.store.settleDocumentPublication(
				ADDRESS,
				{
					...receipt(attempt.publication),
					kind: 'document-bound',
					measured: {
						stateBytes: DOCUMENT_BOUND.stateBytes + 1,
						stateStructs: DOCUMENT_BOUND.stateStructs,
					},
					limit: DOCUMENT_BOUND,
				},
				capturedOf(attempt.publication),
			);

			context.store.installAcceptedDocumentUpdate(ADDRESS, remote);

			expect(context.store.inspectDocument(ADDRESS)).toMatchObject({
				revision: 1,
				owed: true,
				refusedRevision: 1,
			});
			expect(context.store.owedDocuments(null, 64)).toEqual([]);
		} finally {
			context.database.close();
		}
	});

	test('an obsolete refusal for a superseded revision is dropped, not recorded', () => {
		const context = setup();
		try {
			const [first, second] = sourceUpdates('a', 'b');
			if (first === undefined || second === undefined) {
				throw new Error('missing source updates');
			}
			context.store.appendLocalDocumentUpdate(ADDRESS, first);
			const attempt = context.store.documentPublication(ADDRESS);
			if (attempt.kind !== 'ready') throw new Error('publication not ready');
			context.store.appendLocalDocumentUpdate(ADDRESS, second);
			context.store.settleDocumentPublication(
				ADDRESS,
				{
					...receipt(attempt.publication),
					kind: 'document-bound',
					measured: {
						stateBytes: DOCUMENT_BOUND.stateBytes + 1,
						stateStructs: DOCUMENT_BOUND.stateStructs,
					},
					limit: DOCUMENT_BOUND,
				},
				capturedOf(attempt.publication),
			);
			expect(context.store.inspectDocument(ADDRESS)).toMatchObject({
				revision: 2,
				owed: true,
				refusedRevision: null,
			});
		} finally {
			context.database.close();
		}
	});

	test('blocks an over-bound local state by naming only the refused revision', () => {
		const context = setup();
		try {
			const [update] = sourceUpdates('x'.repeat(DOCUMENT_BOUND.stateBytes + 1));
			if (update === undefined) throw new Error('missing source update');
			context.store.appendLocalDocumentUpdate(ADDRESS, update);
			const publication = context.store.documentPublication(ADDRESS);
			if (publication.kind !== 'refused') {
				throw new Error('over-bound document was not refused');
			}
			expect(publication.revision).toBe(1);
			// The whole durable refusal is one revision number: no code, no
			// measurement, and never the oversized payload.
			expect(
				context.database
					.query<{ revision: number }, []>(
						'SELECT document_refused_revision AS revision FROM records',
					)
					.get(),
			).toEqual({ revision: 1 });
			expect(context.store.inspectDocument(ADDRESS)?.refusedRevision).toBe(1);
			expect(context.store.owedDocuments(null, 64)).toEqual([]);
		} finally {
			context.database.close();
		}
	});

	test('deleting over-bound content republishes the same lineage', () => {
		const context = setup();
		try {
			// Oversize is not terminal: the same document repairs in place once
			// the content that crossed the bound is deleted.
			const document = new Y.Doc({ gc: true });
			const updates: Uint8Array[] = [];
			document.on('updateV2', (update: Uint8Array) => {
				updates.push(new Uint8Array(update));
			});
			const filler = 'x'.repeat(DOCUMENT_BOUND.stateBytes + 1);
			const text = document.get('content');
			text.insert(0, filler);
			text.delete(0, filler.length);
			document.destroy();
			const [oversize, deletion] = updates;
			if (oversize === undefined || deletion === undefined) {
				throw new Error('missing source updates');
			}

			context.store.appendLocalDocumentUpdate(ADDRESS, oversize);
			expect(context.store.documentPublication(ADDRESS).kind).toBe('refused');
			expect(context.store.owedDocuments(null, 64)).toEqual([]);

			context.store.appendLocalDocumentUpdate(ADDRESS, deletion);
			expect(
				context.store.inspectDocument(ADDRESS)?.refusedRevision,
			).toBeNull();
			expect(context.store.owedDocuments(null, 64)).toEqual([ADDRESS]);
			const retry = context.store.documentPublication(ADDRESS);
			if (retry.kind !== 'ready')
				throw new Error('repaired document not ready');
			expect(retry.publication.payload.byteLength).toBeLessThan(
				DOCUMENT_BOUND.stateBytes,
			);
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

			const attempt = context.store.documentPublication(ADDRESS);
			if (attempt.kind !== 'ready') throw new Error('publication not ready');
			// A proof whose digest is not the captured attempt's digest is refused.
			expect(() =>
				context.store.settleDocumentPublication(
					ADDRESS,
					{ ...receipt(attempt.publication), digest: 'f'.repeat(64) },
					capturedOf(attempt.publication),
				),
			).toThrow(/captured attempt/);
			expect(context.store.inspectDocument(ADDRESS)?.owed).toBe(true);
		} finally {
			context.database.close();
		}
	});

	test('a valid receipt from the replaced authority lifetime cannot settle successor work', () => {
		const context = setup();
		try {
			const [update] = sourceUpdates('same bytes across lifetimes');
			if (update === undefined) throw new Error('missing source update');
			context.store.appendLocalDocumentUpdate(ADDRESS, update);
			const oldAttempt = context.store.documentPublication(ADDRESS);
			if (oldAttempt.kind !== 'ready') throw new Error('publication not ready');
			const oldReceipt = receipt(oldAttempt.publication);

			context.store.erase();
			context.store.installFacts({
				request: { afterSequence: 0 },
				response: {
					authorityLifetime: 'lifetime-two',
					facts: [
						{ address: ADDRESS, sequence: 1, state: 'live', payload: {} },
					],
					hasMore: false,
				},
			});
			context.store.appendLocalDocumentUpdate(ADDRESS, update);
			const successorAttempt = context.store.documentPublication(ADDRESS);
			if (successorAttempt.kind !== 'ready') {
				throw new Error('successor publication not ready');
			}
			expect(successorAttempt.publication.digest).toBe(oldReceipt.digest);
			expect(() =>
				context.store.settleDocumentPublication(
					ADDRESS,
					oldReceipt,
					capturedOf(successorAttempt.publication),
				),
			).toThrow(/lifetime mismatch/);
			expect(context.store.inspectDocument(ADDRESS)).toMatchObject({
				acceptedRevision: 0,
				owed: true,
			});
		} finally {
			context.database.close();
		}
	});

	test('unset preserves the chain while local tombstone reaps it atomically', () => {
		const context = setup();
		try {
			const [update] = sourceUpdates('a');
			if (update === undefined) throw new Error('missing source update');
			context.store.appendLocalDocumentUpdate(ADDRESS, update);

			context.store.localWrite({ address: ADDRESS, op: 'unset' });
			expect(context.store.exportDocument(ADDRESS)).toBeDefined();
			expect(() =>
				context.store.appendLocalDocumentUpdate(ADDRESS, update),
			).toThrow(/not live/);

			context.store.localWrite({ address: ADDRESS, op: 'replace', value: {} });
			context.store.localWrite({ address: ADDRESS, op: 'tombstone' });
			expect(context.store.exportDocument(ADDRESS)).toBeUndefined();
			expect(context.store.inspectDocument(ADDRESS)).toBeNull();
			expect(
				context.database
					.query<{ count: number }, []>(
						'SELECT count(*) AS count FROM record_documents',
					)
					.get()?.count,
			).toBe(0);
		} finally {
			context.database.close();
		}
	});
});
