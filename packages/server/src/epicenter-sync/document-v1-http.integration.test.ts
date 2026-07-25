/**
 * Data V1 Document HTTP Round-Trip Integration Tests
 *
 * Binds the production publication and pull routes to one in-memory authority
 * and drives them from a real replica store, so the two halves of the one
 * document carrier are proven against each other rather than against a mock.
 *
 * Key behaviors:
 * - Republishing identical state is idempotent and grows no chain
 * - A lost reply regenerates safely without exact-byte retention
 * - A delayed receipt settles only its captured revision, never a newer one
 * - Pull serves exactly what publication accepted, under a version that
 *   changes only when accepted state changes
 * - Lifetime and document-bound refusals mutate no accepted state
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import {
	DOCUMENT_DIGEST_HEADER,
	DOCUMENT_LIFETIME_HEADER,
	DOCUMENT_PROTOCOL_HEADER,
	DOCUMENT_PUBLICATION_VERSION,
	type DocumentAcceptance,
	type DocumentPublicationRequest,
	type DocumentPull,
	documentPayloadDigest,
	documentVersionTag,
	readDocumentAcceptance,
	readDocumentPull,
} from '@epicenter/data/document-v1';
import {
	parseSubmissionRequest,
	SCALAR_SYNC_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import { asPrincipalId } from '@epicenter/identity';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { DOCUMENT_BOUND } from '@epicenter/sync/document-v3';
import * as Y from '@y/y';
import { Hono } from 'hono';
import { expectOk } from 'wellcrafted/testing';

import { openReplicaStore } from '../../../data/src/store/replica/index.js';
import type { Env } from '../types.js';
import { openScalarAuthorityV1 } from './authority-v1.js';
import { createDocumentV1App } from './document-v1-route.js';

const LIFETIME = 'lifetime-one';
const PRINCIPAL_ID = asPrincipalId('document-carrier-proof');
const ADDRESS = {
	namespace: 'so.epicenter.notes',
	collection: 'records',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;
const RECORD_PATH = `/api/sync/v1/records/${ADDRESS.namespace}/${ADDRESS.collection}/${ADDRESS.recordKey}`;
const PATH = `${RECORD_PATH}/document-publications`;
const PULL_PATH = `${RECORD_PATH}/document`;

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
	return {
		authorityRaw,
		replicaRaw,
		authority,
		replica,
		app,
		locatedPrincipals,
		close() {
			authorityRaw.close();
			replicaRaw.close();
		},
	};
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

async function pullHttp(
	app: Hono<Env>,
	{
		knownDocumentVersion = null,
		authorityLifetime = LIFETIME,
	}: { knownDocumentVersion?: string | null; authorityLifetime?: string } = {},
): Promise<{ pull: DocumentPull; status: number }> {
	const response = await app.request(PULL_PATH, {
		headers: {
			[DOCUMENT_LIFETIME_HEADER]: authorityLifetime,
			...(knownDocumentVersion === null
				? {}
				: { 'if-none-match': documentVersionTag(knownDocumentVersion) }),
		},
	});
	const status = response.status;
	const pull = await readDocumentPull(response, SCALAR_SYNC_V1_LIMITS);
	return { pull, status };
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

describe('document V1 HTTP round trip', () => {
	test('republishing identical state is idempotent and grows no chain', async () => {
		const context = setup();
		try {
			const request = requestFor(updateFor('one accepted document'));
			const first = await publishHttp(context.app, request);
			expect(first.status).toBe(200);
			expect(context.locatedPrincipals).toEqual([PRINCIPAL_ID]);
			expect(chainEntries(context.authorityRaw)).toBe(1);

			for (let attempt = 0; attempt < 3; attempt += 1) {
				const repeated = await publishHttp(context.app, request);
				expect(repeated.acceptance).toEqual(first.acceptance);
				expect(repeated.bytes).toEqual(first.bytes);
				expect(chainEntries(context.authorityRaw)).toBe(1);
			}
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

			// The authority committed, but the reply never reached the replica.
			const lost = await publishHttp(context.app, first.publication);
			expect(lost.acceptance.kind).toBe('accepted');
			expect(context.replica.inspectDocument(ADDRESS)?.owed).toBe(true);

			// Nothing exact was retained; the next attempt reconstructs from SQLite.
			const regenerated = context.replica.documentPublication(ADDRESS);
			if (regenerated.kind !== 'ready') {
				throw new Error('regenerated publication was not ready');
			}
			expect(regenerated.publication.digest).toBe(first.publication.digest);
			const retried = await publishHttp(context.app, regenerated.publication);
			expect(retried.acceptance).toEqual(lost.acceptance);
			if (retried.acceptance.kind !== 'accepted') {
				throw new Error('regenerated publication was refused');
			}

			// A local edit races the late settlement: it may not be cleared.
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
			const latestResult = await publishHttp(context.app, latest.publication);
			if (latestResult.acceptance.kind !== 'accepted') {
				throw new Error('latest publication was refused');
			}
			context.replica.settleDocumentPublication(
				ADDRESS,
				latestResult.acceptance.receipt,
				{
					revision: latest.publication.capturedRevision,
					digest: latest.publication.digest,
				},
			);
			expect(context.replica.inspectDocument(ADDRESS)).toMatchObject({
				acceptedRevision: 2,
				owed: false,
			});
		} finally {
			context.close();
		}
	});

	test('pull serves what publication accepted, under a version that tracks accepted state', async () => {
		const context = setup();
		try {
			const empty = await pullHttp(context.app);
			expect(empty.status).toBe(204);
			expect(empty.pull.kind).toBe('absent');

			const published = updateFor('published');
			await publishHttp(context.app, requestFor(published));
			const served = await pullHttp(context.app);
			expect(served.status).toBe(200);
			if (served.pull.kind !== 'state') throw new Error('pull served no state');
			expect([...served.pull.update]).toEqual([
				...(context.authority.exportDocument(ADDRESS) ?? new Uint8Array()),
			]);

			// Republishing the same state changes nothing, so neither does the
			// version, and a conditional pull transfers no body. The bytes must be
			// the same authorship: a re-derived "identical" edit is a different Yjs
			// client and legitimately merges into new state.
			await publishHttp(context.app, requestFor(published));
			const unchanged = await pullHttp(context.app, {
				knownDocumentVersion: served.pull.documentVersion,
			});
			expect(unchanged.status).toBe(304);
			expect(unchanged.pull).toEqual({
				kind: 'unchanged',
				activeAuthorityLifetime: LIFETIME,
				documentVersion: served.pull.documentVersion,
			});

			// New accepted state advances the version and serves a body again.
			await publishHttp(context.app, requestFor(updateFor('and more')));
			const advanced = await pullHttp(context.app, {
				knownDocumentVersion: served.pull.documentVersion,
			});
			expect(advanced.status).toBe(200);
			if (advanced.pull.kind !== 'state') {
				throw new Error('advanced pull served no state');
			}
			expect(advanced.pull.documentVersion).not.toBe(
				served.pull.documentVersion,
			);
		} finally {
			context.close();
		}
	});

	test('both routes refuse a superseded lifetime with one shape', async () => {
		const context = setup();
		try {
			const stalePublication = await publishHttp(
				context.app,
				requestFor(updateFor('stale lifetime'), 'lifetime-old'),
			);
			const stalePull = await pullHttp(context.app, {
				authorityLifetime: 'lifetime-old',
			});
			expect(stalePublication.status).toBe(409);
			expect(stalePull.status).toBe(409);
			const refusal = {
				kind: 'lifetime-mismatch',
				activeAuthorityLifetime: LIFETIME,
			} as const;
			expect(stalePublication.acceptance).toEqual(refusal);
			expect(stalePull.pull).toEqual(refusal);
		} finally {
			context.close();
		}
	});

	test('an over-bound publication is refused without mutating accepted state', async () => {
		const context = setup();
		try {
			await publishHttp(context.app, requestFor(updateFor('kept')));
			const before = await pullHttp(context.app);
			if (before.pull.kind !== 'state') throw new Error('pull served no state');
			const entriesBefore = chainEntries(context.authorityRaw);

			const oversized = updateFor('x'.repeat(DOCUMENT_BOUND.stateBytes + 1));
			const refused = await publishHttp(context.app, requestFor(oversized));
			expect(refused.status).toBe(409);
			expect(refused.acceptance).toMatchObject({
				kind: 'document-bound',
				limit: DOCUMENT_BOUND,
			});

			expect(chainEntries(context.authorityRaw)).toBe(entriesBefore);
			const after = await pullHttp(context.app, {
				knownDocumentVersion: before.pull.documentVersion,
			});
			expect(after.status).toBe(304);
		} finally {
			context.close();
		}
	});
});
