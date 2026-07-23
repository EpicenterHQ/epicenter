/**
 * Data V1 Document Realtime Overlay Tests
 *
 * Verifies that fixed-address WebSocket updates enter the authority's durable
 * document acceptance operation and return its semantic result before fanout.
 *
 * Key behaviors:
 * - Accepted updates return a digest-bound post-commit receipt
 * - Peer fanout happens only after durable authority acceptance
 * - Bound refusals return the shared diagnostic before the transport backstop
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
	decodeDocumentAcceptance,
	documentPayloadDigest,
} from '@epicenter/data/document-v1';
import {
	parseSubmissionRequest,
	SCALAR_SYNC_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import {
	DOCUMENT_BACKSTOP_CLOSE_CODE,
	decodeDocumentFrame,
	encodeDocumentFrame,
} from '@epicenter/sync/document-v3';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';

import { openScalarAuthorityV1 } from './authority-v1.js';
import {
	createDocumentRealtimeV1Server,
	type DocumentRealtimeV1Socket,
} from './document-realtime-v1.js';

const ADDRESS = {
	namespace: 'so.epicenter.notes',
	collection: 'records',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

function setup() {
	const raw = new Database(':memory:', { strict: true });
	const stored = openScalarAuthorityV1({
		database: createBunSqliteAdapter(raw),
		limits: SCALAR_SYNC_V1_LIMITS,
		initialize: { authorityLifetime: 'lifetime-one' },
	});
	expectOk(
		stored.submit(
			expectOk(
				parseSubmissionRequest(
					{
						authorityLifetime: 'lifetime-one',
						replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
						submissionNumber: 1,
						intents: [{ address: ADDRESS, op: 'replace', value: {} }],
					},
					SCALAR_SYNC_V1_LIMITS,
				),
			),
		),
	);
	let acceptCalls = 0;
	const authority = {
		...stored,
		acceptDocument(request: Parameters<typeof stored.acceptDocument>[0]) {
			acceptCalls += 1;
			return stored.acceptDocument(request);
		},
	};
	return {
		raw,
		stored,
		server: createDocumentRealtimeV1Server({ authority }),
		acceptCalls: () => acceptCalls,
	};
}

function socket() {
	const sent: Uint8Array[] = [];
	const closed: { code?: number; reason?: string }[] = [];
	const value: DocumentRealtimeV1Socket = {
		send(data) {
			sent.push(new Uint8Array(data));
		},
		close(code, reason) {
			closed.push({ code, reason });
		},
	};
	return { value, sent, closed };
}

function updateFor(value: string): Uint8Array {
	const document = new Y.Doc({ gc: true });
	document.get('content').insert(0, value);
	const update = new Uint8Array(Y.encodeStateAsUpdateV2(document));
	document.destroy();
	return update;
}

function dependencyOnlyDiff(): Uint8Array {
	const document = new Y.Doc({ gc: true });
	document.get('content').insert(0, 'a');
	const afterFirst = Y.encodeStateVector(document);
	document.get('content').insert(0, 'b');
	const update = new Uint8Array(Y.encodeStateAsUpdateV2(document, afterFirst));
	document.destroy();
	return update;
}

function connect(
	server: ReturnType<typeof createDocumentRealtimeV1Server>,
	peer: DocumentRealtimeV1Socket,
): void {
	const document = new Y.Doc({ gc: true });
	const stateVector = Y.encodeStateVector(document);
	document.destroy();
	server.receive(
		peer,
		ADDRESS,
		'lifetime-one',
		encodeDocumentFrame({
			kind: 'sync-request',
			stateVector,
		}),
	);
}

function lastAcceptance(sent: Uint8Array[]) {
	const frame = decodeDocumentFrame(sent.at(-1) ?? new Uint8Array());
	if (frame.kind !== 'publication-response') {
		throw new Error('expected document publication response');
	}
	const acceptance = decodeDocumentAcceptance(
		frame.acceptance,
		SCALAR_SYNC_V1_LIMITS,
	);
	if (acceptance === undefined) {
		throw new Error('invalid document publication response');
	}
	return acceptance;
}

describe('document realtime V1 overlay', () => {
	test('rejects malformed Yjs bytes before authority acceptance', () => {
		const context = setup();
		try {
			const peer = socket();
			connect(context.server, peer.value);
			const callsBefore = context.acceptCalls();
			context.server.receive(
				peer.value,
				ADDRESS,
				'lifetime-one',
				encodeDocumentFrame({
					kind: 'update',
					update: new Uint8Array([1, 2, 3]),
				}),
			);
			expect(context.acceptCalls()).toBe(callsBefore);
			expect(peer.closed.at(-1)).toEqual({
				code: 1002,
				reason: 'invalid-document-frame',
			});
		} finally {
			context.raw.close();
		}
	});

	test('does not receipt a diff whose claimed prerequisite is absent', () => {
		const context = setup();
		try {
			const peer = socket();
			connect(context.server, peer.value);
			const callsBefore = context.acceptCalls();
			context.server.receive(
				peer.value,
				ADDRESS,
				'lifetime-one',
				encodeDocumentFrame({
					kind: 'update',
					update: dependencyOnlyDiff(),
				}),
			);
			expect(context.acceptCalls()).toBe(callsBefore);
			expect(context.stored.exportDocument(ADDRESS)).toBeUndefined();
			expect(peer.closed.at(-1)).toEqual({
				code: 1002,
				reason: 'invalid-document-frame',
			});
			expect(
				peer.sent.map(decodeDocumentFrame).map((frame) => frame.kind),
			).toEqual(['sync-request', 'sync-response']);
		} finally {
			context.raw.close();
		}
	});

	test('uses the authority acceptance function, returns its receipt, and fans out', () => {
		const context = setup();
		try {
			const first = socket();
			const second = socket();
			connect(context.server, first.value);
			connect(context.server, second.value);
			expect(
				first.sent.map(decodeDocumentFrame).map((frame) => frame.kind),
			).toEqual(['sync-request', 'sync-response']);

			const update = updateFor('live');
			context.server.receive(
				first.value,
				ADDRESS,
				'lifetime-one',
				encodeDocumentFrame({ kind: 'update', update }),
			);
			expect(context.acceptCalls()).toBe(1);
			expect(first.sent).toHaveLength(3);
			expect(lastAcceptance(first.sent)).toEqual({
				kind: 'accepted',
				receipt: {
					authorityLifetime: 'lifetime-one',
					address: ADDRESS,
					protocolVersion: 'epicenter-document-v3',
					digest: documentPayloadDigest(update),
				},
			});
			expect(
				decodeDocumentFrame(second.sent.at(-1) ?? new Uint8Array()).kind,
			).toBe('update');
			expect(context.stored.exportDocument(ADDRESS)).toBeDefined();
		} finally {
			context.raw.close();
		}
	});

	test('uses the transport backstop for a document-bound update', () => {
		const context = setup();
		try {
			const peer = socket();
			connect(context.server, peer.value);
			context.server.receive(
				peer.value,
				ADDRESS,
				'lifetime-one',
				encodeDocumentFrame({
					kind: 'update',
					update: updateFor('x'.repeat(1_048_577)),
				}),
			);
			expect(lastAcceptance(peer.sent)).toMatchObject({
				kind: 'document-bound',
				authorityLifetime: 'lifetime-one',
				address: ADDRESS,
			});
			expect(peer.closed).toEqual([
				{ code: DOCUMENT_BACKSTOP_CLOSE_CODE, reason: 'document-bound' },
			]);
		} finally {
			context.raw.close();
		}
	});

	test('a reply send failure after commit leaves exact retry idempotent', () => {
		const context = setup();
		try {
			const failed = socket();
			connect(context.server, failed.value);
			failed.value.send = () => {
				throw new Error('reply lost');
			};
			const update = updateFor('committed before reply loss');
			context.server.receive(
				failed.value,
				ADDRESS,
				'lifetime-one',
				encodeDocumentFrame({ kind: 'update', update }),
			);
			expect(context.acceptCalls()).toBe(1);
			expect(failed.closed).toEqual([{ code: 1011, reason: 'send-failed' }]);

			const retry = socket();
			connect(context.server, retry.value);
			context.server.receive(
				retry.value,
				ADDRESS,
				'lifetime-one',
				encodeDocumentFrame({ kind: 'update', update }),
			);
			expect(lastAcceptance(retry.sent)).toMatchObject({ kind: 'accepted' });
			expect(context.acceptCalls()).toBe(2);
			expect(
				context.raw
					.query<{ count: number }, []>(
						'SELECT count(*) AS count FROM record_documents',
					)
					.get()?.count,
			).toBe(1);
		} finally {
			context.raw.close();
		}
	});
});
