/**
 * Data V1 Document HTTP Publication Route Tests
 *
 * Verifies binary request admission, principal routing, and the shared
 * authority acceptance response returned by the HTTP carrier.
 *
 * Key behaviors:
 * - Accepted bytes return the digest-bound post-commit receipt
 * - Malformed requests stop before authority lookup
 * - Semantic lifetime and document-bound refusals retain their shared shape
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
	DOCUMENT_PUBLICATION_VERSION,
	documentPayloadDigest,
} from '@epicenter/data/document-v1';
import { parseSubmissionRequest } from '@epicenter/data/protocol/v1';
import { asPrincipalId, type PrincipalId } from '@epicenter/identity';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { DOCUMENT_BOUND } from '@epicenter/sync/document-v3';
import * as Y from '@y/y';
import { Hono } from 'hono';
import { expectOk } from 'wellcrafted/testing';

import type { Env } from '../types.js';
import { openScalarAuthorityV1 } from './authority-v1.js';
import { authorityV1TestLimits } from './authority-v1-cases.test-support.js';
import {
	createDocumentV1App,
	DOCUMENT_DIGEST_HEADER,
	DOCUMENT_LIFETIME_HEADER,
	DOCUMENT_PROTOCOL_HEADER,
} from './document-v1-route.js';

const LIFETIME = 'lifetime-one';
const ADDRESS = {
	namespace: 'so.epicenter.notes',
	collection: 'records',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;
const PATH = `/api/sync/v1/records/${ADDRESS.namespace}/${ADDRESS.collection}/${ADDRESS.recordKey}/document-publications`;

function setup() {
	const raw = new Database(':memory:', { strict: true });
	const limits = authorityV1TestLimits();
	const authority = openScalarAuthorityV1({
		database: createBunSqliteAdapter(raw),
		limits,
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
						intents: [
							{ address: ADDRESS, op: 'replace', value: { title: 'live' } },
						],
					},
					limits,
				),
			),
		),
	);
	const principals: PrincipalId[] = [];
	const app = new Hono<Env>();
	app.use('*', async (c, next) => {
		c.set('principal', { id: asPrincipalId('alice') });
		await next();
	});
	app.route(
		'/',
		createDocumentV1App({
			limits,
			locateAuthority(principalId) {
				principals.push(principalId);
				return authority;
			},
		}),
	);
	return { app, authority, principals, close: () => raw.close() };
}

function updateFor(value: string): Uint8Array {
	const document = new Y.Doc({ gc: true });
	document.get('content').insert(0, value);
	const update = new Uint8Array(Y.encodeStateAsUpdateV2(document));
	document.destroy();
	return update;
}

function headers(payload: Uint8Array) {
	return {
		'content-type': 'application/octet-stream',
		[DOCUMENT_LIFETIME_HEADER]: LIFETIME,
		[DOCUMENT_PROTOCOL_HEADER]: DOCUMENT_PUBLICATION_VERSION,
		[DOCUMENT_DIGEST_HEADER]: documentPayloadDigest(payload),
	};
}

function bodyOf(payload: Uint8Array): ArrayBuffer {
	return payload.buffer.slice(
		payload.byteOffset,
		payload.byteOffset + payload.byteLength,
	) as ArrayBuffer;
}

describe('document V1 publication route', () => {
	test('admits bounded binary bytes and returns the authority postcommit receipt', async () => {
		const context = setup();
		try {
			const payload = updateFor('published');
			const response = await context.app.request(PATH, {
				method: 'POST',
				headers: headers(payload),
				body: bodyOf(payload),
			});
			expect(response.status).toBe(200);
			expect((await response.json()) as unknown).toMatchObject({
				kind: 'accepted',
				receipt: {
					authorityLifetime: LIFETIME,
					address: ADDRESS,
					protocolVersion: DOCUMENT_PUBLICATION_VERSION,
					digest: documentPayloadDigest(payload),
				},
			});
			expect(context.principals).toEqual([asPrincipalId('alice')]);
			expect(context.authority.exportDocument(ADDRESS)).toBeDefined();
		} finally {
			context.close();
		}
	});

	test('returns the bounded authority refusal without mutating accepted state', async () => {
		const context = setup();
		try {
			const before = context.authority.exportDocument(ADDRESS);
			const payload = updateFor('x'.repeat(DOCUMENT_BOUND.stateBytes + 1));
			const response = await context.app.request(PATH, {
				method: 'POST',
				headers: headers(payload),
				body: bodyOf(payload),
			});
			expect(response.status).toBe(409);
			expect((await response.json()) as unknown).toMatchObject({
				kind: 'document-bound',
				authorityLifetime: LIFETIME,
				address: ADDRESS,
				protocolVersion: DOCUMENT_PUBLICATION_VERSION,
				digest: documentPayloadDigest(payload),
				limit: DOCUMENT_BOUND,
			});
			expect(context.authority.exportDocument(ADDRESS)).toEqual(before);
		} finally {
			context.close();
		}
	});

	test('rejects malformed metadata and bodies before locating authority', async () => {
		const context = setup();
		try {
			const payload = updateFor('x');
			for (const request of [
				{
					headers: { ...headers(payload), [DOCUMENT_DIGEST_HEADER]: 'bad' },
					body: bodyOf(payload),
				},
				{
					headers: { ...headers(payload), 'content-type': 'application/json' },
					body: bodyOf(payload),
				},
				{ headers: headers(payload), body: new ArrayBuffer(0) },
			]) {
				const response = await context.app.request(PATH, {
					method: 'POST',
					...request,
				});
				expect(response.status).toBe(400);
			}
			expect(context.principals).toEqual([]);
		} finally {
			context.close();
		}
	});

	test('maps semantic refusal without inventing a transport receipt', async () => {
		const context = setup();
		try {
			const payload = updateFor('x');
			const response = await context.app.request(PATH, {
				method: 'POST',
				headers: { ...headers(payload), [DOCUMENT_LIFETIME_HEADER]: 'old' },
				body: bodyOf(payload),
			});
			expect(response.status).toBe(409);
			expect((await response.json()) as unknown).toEqual({
				kind: 'lifetime-mismatch',
				activeAuthorityLifetime: LIFETIME,
			});
		} finally {
			context.close();
		}
	});
});
