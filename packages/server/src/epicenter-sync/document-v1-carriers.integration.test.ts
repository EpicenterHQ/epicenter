/**
 * Data V1 Document Carrier Equivalence Integration Tests
 *
 * Binds the production HTTP route and realtime server to one in-memory
 * authority, then exercises publication receipts against a real replica store.
 *
 * Key behaviors:
 * - HTTP and WebSocket return byte-equivalent authority acceptance
 * - Duplicate delivery and reconnect remain idempotent
 * - Lost and delayed receipts settle only their captured local revisions
 * - Lifetime and document-bound refusals have one carrier-independent shape
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import {
	DOCUMENT_PUBLICATION_VERSION,
	type DocumentAcceptance,
	type DocumentPublicationRequest,
	decodeDocumentAcceptance,
	documentPayloadDigest,
	readDocumentAcceptance,
} from '@epicenter/data/document-v1';
import {
	parseSubmissionRequest,
	SCALAR_SYNC_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import { asPrincipalId } from '@epicenter/identity';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import {
	DOCUMENT_BACKSTOP_CLOSE_CODE,
	DOCUMENT_BOUND,
	decodeDocumentFrame,
	encodeDocumentFrame,
} from '@epicenter/sync/document-v3';
import * as Y from '@y/y';
import { Hono } from 'hono';
import { expectOk } from 'wellcrafted/testing';

import { openReplicaStore } from '../../../data/src/store/replica/index.js';
import type { Env } from '../types.js';
import { openScalarAuthorityV1 } from './authority-v1.js';
import {
	createDocumentRealtimeV1Server,
	type DocumentRealtimeV1Socket,
} from './document-realtime-v1.js';
import {
	createDocumentV1App,
	DOCUMENT_DIGEST_HEADER,
	DOCUMENT_LIFETIME_HEADER,
	DOCUMENT_PROTOCOL_HEADER,
} from './document-v1-route.js';

const LIFETIME = 'lifetime-one';
const PRINCIPAL_ID = asPrincipalId('document-carrier-proof');
const ADDRESS = {
	namespace: 'so.epicenter.notes',
	collection: 'records',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;
const PATH = `/api/sync/v1/records/${ADDRESS.namespace}/${ADDRESS.collection}/${ADDRESS.recordKey}/document-publications`;

function updateFor(value: string): Uint8Array {
	const document = new Y.Doc({ gc: true });
	try {
		document.get('content').insert(0, value);
		return new Uint8Array(Y.encodeStateAsUpdateV2(document));
	} finally {
		document.destroy();
	}
}

function dependentUpdates(...values: string[]): Uint8Array[] {
	const document = new Y.Doc({ gc: true });
	const updates: Uint8Array[] = [];
	document.on('updateV2', (update: Uint8Array) => {
		updates.push(new Uint8Array(update));
	});
	for (const value of values) document.get('content').insert(0, value);
	document.destroy();
	return updates;
}

function bodyOf(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

function setup() {
	const authorityRaw = new Database(':memory:', { strict: true });
	const replicaRaw = new Database(':memory:', { strict: true });
	const authority = openScalarAuthorityV1({
		database: createBunSqliteAdapter(authorityRaw),
		limits: SCALAR_SYNC_V1_LIMITS,
		initialize: { authorityLifetime: LIFETIME },
	});
	expectOk(
		authority.submit(
			expectOk(
				parseSubmissionRequest(
					{
						authorityLifetime: LIFETIME,
						replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
						submissionNumber: 1,
						intents: [{ address: ADDRESS, op: 'replace', value: {} }],
					},
					SCALAR_SYNC_V1_LIMITS,
				),
			),
		),
	);
	const replica = openReplicaStore({
		database: createBunSqliteAdapter(replicaRaw),
		limits: SCALAR_SYNC_V1_LIMITS,
		owner: null,
		initialize: {
			replicaId: 'llllllllllllllllllllllll',
			authorityLifetime: LIFETIME,
		},
	});
	replica.localWrite({ address: ADDRESS, op: 'replace', value: {} });

	const locatedPrincipals: string[] = [];
	const app = new Hono<Env>();
	app.use('*', async (context, next) => {
		context.set('principal', { id: PRINCIPAL_ID });
		await next();
	});
	app.route(
		'/',
		createDocumentV1App({
			limits: SCALAR_SYNC_V1_LIMITS,
			locateAuthority(principalId) {
				locatedPrincipals.push(principalId);
				return authority;
			},
		}),
	);
	const realtime = createDocumentRealtimeV1Server({ authority });
	return {
		authorityRaw,
		replicaRaw,
		authority,
		replica,
		app,
		realtime,
		locatedPrincipals,
		close() {
			authorityRaw.close();
			replicaRaw.close();
		},
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

function connect(
	realtime: ReturnType<typeof createDocumentRealtimeV1Server>,
	peer: DocumentRealtimeV1Socket,
	authorityLifetime = LIFETIME,
): void {
	const document = new Y.Doc({ gc: true });
	const stateVector = Y.encodeStateVector(document);
	document.destroy();
	realtime.receive(
		peer,
		ADDRESS,
		authorityLifetime,
		encodeDocumentFrame({ kind: 'sync-request', stateVector }),
	);
}

function publishRealtime(
	realtime: ReturnType<typeof createDocumentRealtimeV1Server>,
	peer: ReturnType<typeof socket>,
	payload: Uint8Array,
	authorityLifetime = LIFETIME,
): { acceptance: DocumentAcceptance; bytes: Uint8Array } {
	realtime.receive(
		peer.value,
		ADDRESS,
		authorityLifetime,
		encodeDocumentFrame({ kind: 'update', update: payload }),
	);
	const frame = decodeDocumentFrame(peer.sent.at(-1) ?? new Uint8Array());
	if (frame.kind !== 'publication-response') {
		throw new Error('realtime carrier returned no publication response');
	}
	const acceptance = decodeDocumentAcceptance(
		frame.acceptance,
		SCALAR_SYNC_V1_LIMITS,
	);
	if (acceptance === undefined) {
		throw new Error('realtime carrier returned invalid authority acceptance');
	}
	return { acceptance, bytes: frame.acceptance };
}

async function publishHttp(
	app: Hono<Env>,
	request: DocumentPublicationRequest,
): Promise<{
	acceptance: DocumentAcceptance;
	bytes: Uint8Array;
	status: number;
}> {
	const response = await app.request(PATH, {
		method: 'POST',
		headers: {
			'content-type': 'application/octet-stream',
			[DOCUMENT_LIFETIME_HEADER]: request.authorityLifetime,
			[DOCUMENT_PROTOCOL_HEADER]: request.protocolVersion,
			[DOCUMENT_DIGEST_HEADER]: request.digest,
		},
		body: bodyOf(request.payload),
	});
	// Decode exactly the way shipped carriers do, so a carrier that discards a
	// valid conflict response cannot pass through this harness unnoticed.
	const bytes = new Uint8Array(await response.clone().arrayBuffer());
	const acceptance = await readDocumentAcceptance(
		response,
		SCALAR_SYNC_V1_LIMITS,
	);
	return { acceptance, bytes, status: response.status };
}

function requestFor(
	payload: Uint8Array,
	authorityLifetime = LIFETIME,
): DocumentPublicationRequest {
	return {
		authorityLifetime,
		address: ADDRESS,
		protocolVersion: DOCUMENT_PUBLICATION_VERSION,
		payload,
		digest: documentPayloadDigest(payload),
	};
}

function chainEntries(raw: Database): number {
	return (
		raw
			.query<{ count: number }, []>(
				'SELECT count(*) AS count FROM record_documents',
			)
			.get()?.count ?? 0
	);
}

describe('document V1 carrier equivalence', () => {
	test('HTTP, duplicate WebSocket delivery, and reconnect return one idempotent receipt', async () => {
		const context = setup();
		try {
			const request = requestFor(updateFor('one accepted document'));
			const http = await publishHttp(context.app, request);
			expect(http.status).toBe(200);
			expect(context.locatedPrincipals).toEqual([PRINCIPAL_ID]);
			expect(chainEntries(context.authorityRaw)).toBe(1);

			const first = socket();
			connect(context.realtime, first.value);
			const realtime = publishRealtime(
				context.realtime,
				first,
				request.payload,
			);
			expect(realtime.acceptance).toEqual(http.acceptance);
			expect(realtime.bytes).toEqual(http.bytes);
			expect(chainEntries(context.authorityRaw)).toBe(1);

			expect(
				publishRealtime(context.realtime, first, request.payload).acceptance,
			).toEqual(http.acceptance);
			expect(chainEntries(context.authorityRaw)).toBe(1);

			context.realtime.disconnect(first.value);
			const reconnected = socket();
			connect(context.realtime, reconnected.value);
			expect(
				publishRealtime(context.realtime, reconnected, request.payload)
					.acceptance,
			).toEqual(http.acceptance);
			expect(chainEntries(context.authorityRaw)).toBe(1);
		} finally {
			context.close();
		}
	});

	test('a lost reply regenerates safely and a delayed receipt cannot settle racing work', async () => {
		const context = setup();
		try {
			const [firstUpdate, racingUpdate] = dependentUpdates('a', 'b');
			if (firstUpdate === undefined || racingUpdate === undefined) {
				throw new Error('missing dependent document updates');
			}
			context.replica.appendLocalDocumentUpdate(ADDRESS, firstUpdate);
			const first = context.replica.documentPublication(ADDRESS);
			if (first.kind !== 'ready') throw new Error('publication was not ready');

			const peer = socket();
			connect(context.realtime, peer.value);
			const lost = publishRealtime(
				context.realtime,
				peer,
				first.publication.payload,
			).acceptance;
			expect(lost.kind).toBe('accepted');
			expect(context.replica.inspectDocument(ADDRESS)?.owed).toBe(true);

			const regenerated = context.replica.documentPublication(ADDRESS);
			if (regenerated.kind !== 'ready') {
				throw new Error('regenerated publication was not ready');
			}
			expect(regenerated.publication.digest).toBe(first.publication.digest);
			const retried = await publishHttp(context.app, regenerated.publication);
			expect(retried.acceptance).toEqual(lost);
			if (retried.acceptance.kind !== 'accepted') {
				throw new Error('regenerated publication was refused');
			}

			context.replica.appendLocalDocumentUpdate(ADDRESS, racingUpdate);
			context.replica.settleDocumentPublication(
				ADDRESS,
				retried.acceptance.receipt,
				{
					revision: regenerated.publication.capturedRevision,
					digest: regenerated.publication.digest,
				},
			);
			expect(context.replica.inspectDocument(ADDRESS)).toMatchObject({
				revision: 2,
				acceptedRevision: 1,
				owed: true,
			});

			const latest = context.replica.documentPublication(ADDRESS);
			if (latest.kind !== 'ready')
				throw new Error('latest publication not ready');
			const latestResult = publishRealtime(
				context.realtime,
				peer,
				latest.publication.payload,
			).acceptance;
			if (latestResult.kind !== 'accepted') {
				throw new Error('latest publication was refused');
			}
			context.replica.settleDocumentPublication(ADDRESS, latestResult.receipt, {
				revision: latest.publication.capturedRevision,
				digest: latest.publication.digest,
			});
			expect(context.replica.inspectDocument(ADDRESS)).toMatchObject({
				acceptedRevision: 2,
				owed: false,
			});
		} finally {
			context.close();
		}
	});

	test('both carriers return the same lifetime and document-bound refusals', async () => {
		const context = setup();
		try {
			const ordinary = updateFor('stale lifetime');
			const staleHttp = await publishHttp(
				context.app,
				requestFor(ordinary, 'lifetime-old'),
			);
			const staleSocket = socket();
			connect(context.realtime, staleSocket.value, 'lifetime-old');
			const staleRealtime = publishRealtime(
				context.realtime,
				staleSocket,
				ordinary,
				'lifetime-old',
			);
			expect(staleHttp.status).toBe(409);
			expect(staleRealtime.acceptance).toEqual(staleHttp.acceptance);
			expect(staleRealtime.bytes).toEqual(staleHttp.bytes);
			expect(staleHttp.acceptance).toEqual({
				kind: 'lifetime-mismatch',
				activeAuthorityLifetime: LIFETIME,
			});

			const oversized = updateFor('x'.repeat(DOCUMENT_BOUND.stateBytes + 1));
			const before = chainEntries(context.authorityRaw);
			const boundHttp = await publishHttp(context.app, requestFor(oversized));
			const boundSocket = socket();
			connect(context.realtime, boundSocket.value);
			const boundRealtime = publishRealtime(
				context.realtime,
				boundSocket,
				oversized,
			);
			expect(boundHttp.status).toBe(409);
			expect(boundRealtime.acceptance).toEqual(boundHttp.acceptance);
			expect(boundRealtime.bytes).toEqual(boundHttp.bytes);
			expect(boundHttp.acceptance).toMatchObject({
				kind: 'document-bound',
				limit: DOCUMENT_BOUND,
			});
			expect(boundSocket.closed).toEqual([
				{ code: DOCUMENT_BACKSTOP_CLOSE_CODE, reason: 'document-bound' },
			]);
			expect(chainEntries(context.authorityRaw)).toBe(before);
		} finally {
			context.close();
		}
	});
});
