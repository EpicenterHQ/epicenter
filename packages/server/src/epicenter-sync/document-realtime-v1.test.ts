import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
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

describe('document realtime V1 overlay', () => {
	test('uses the authority acceptance function, fans out, and sends no durability receipt', () => {
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
			expect(first.sent).toHaveLength(2);
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
			expect(peer.closed).toEqual([
				{ code: DOCUMENT_BACKSTOP_CLOSE_CODE, reason: 'document-bound' },
			]);
		} finally {
			context.raw.close();
		}
	});
});
