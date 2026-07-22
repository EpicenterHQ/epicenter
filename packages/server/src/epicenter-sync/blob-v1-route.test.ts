import { describe, expect, test } from 'bun:test';

import {
	BLOB_PUBLICATION_VERSION,
	type BlobPublicationRequest,
} from '@epicenter/data/blob-v1';
import { sha256Hex } from '@epicenter/data/protocol/v1';
import { asPrincipalId, type PrincipalId } from '@epicenter/identity';
import { Hono } from 'hono';

import type { Env } from '../types.js';
import { authorityV1TestLimits } from './authority-v1-cases.test-support.js';
import {
	BLOB_DIGEST_HEADER,
	BLOB_LIFETIME_HEADER,
	BLOB_PROTOCOL_HEADER,
	createBlobV1App,
} from './blob-v1-route.js';

const LIFETIME = 'lifetime-one';
const ADDRESS = {
	namespace: 'so.epicenter.notes',
	collection: 'assets',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;
const PUBLICATION_PATH = `/api/sync/v1/records/${ADDRESS.namespace}/${ADDRESS.collection}/${ADDRESS.recordKey}/blob-publications`;
const BYTES_PATH = `/api/sync/v1/records/${ADDRESS.namespace}/${ADDRESS.collection}/${ADDRESS.recordKey}/blob`;

function setup() {
	const principals: PrincipalId[] = [];
	let accepted: { request: BlobPublicationRequest; text: string } | undefined;
	const app = new Hono<Env>();
	app.use('*', async (c, next) => {
		c.set('principal', { id: asPrincipalId('alice') });
		await next();
	});
	app.route(
		'/',
		createBlobV1App({
			limits: authorityV1TestLimits(),
			locateAuthority(principalId) {
				principals.push(principalId);
				return {
					async accept(request, bytes) {
						accepted = { request, text: await new Response(bytes).text() };
						return { kind: 'accepted' as const, receipt: request };
					},
					async read() {
						return accepted === undefined
							? undefined
							: new Blob([accepted.text]).stream();
					},
				};
			},
		}),
	);
	return { app, principals, accepted: () => accepted };
}

function headers(value: string) {
	return {
		'content-type': 'application/octet-stream',
		[BLOB_LIFETIME_HEADER]: LIFETIME,
		[BLOB_PROTOCOL_HEADER]: BLOB_PUBLICATION_VERSION,
		[BLOB_DIGEST_HEADER]: sha256Hex(value),
	};
}

describe('blob V1 routes', () => {
	test('streams record-addressed bytes into acceptance and back out', async () => {
		const context = setup();
		const response = await context.app.request(PUBLICATION_PATH, {
			method: 'POST',
			headers: headers('streamed bytes'),
			body: 'streamed bytes',
		});
		expect(response.status).toBe(200);
		expect((await response.json()) as unknown).toEqual({
			kind: 'accepted',
			receipt: {
				authorityLifetime: LIFETIME,
				address: ADDRESS,
				protocolVersion: BLOB_PUBLICATION_VERSION,
				digest: sha256Hex('streamed bytes'),
			},
		});
		expect(context.accepted()?.text).toBe('streamed bytes');
		expect(context.principals).toEqual([asPrincipalId('alice')]);

		const read = await context.app.request(BYTES_PATH);
		expect(read.status).toBe(200);
		expect(read.headers.get('content-type')).toBe('application/octet-stream');
		expect(await read.text()).toBe('streamed bytes');
	});

	test('rejects malformed metadata before locating an authority', async () => {
		const context = setup();
		for (const request of [
			{
				headers: { ...headers('x'), [BLOB_DIGEST_HEADER]: 'bad' },
				body: 'x',
			},
			{
				headers: { ...headers('x'), 'content-type': 'application/json' },
				body: 'x',
			},
		]) {
			const response = await context.app.request(PUBLICATION_PATH, {
				method: 'POST',
				...request,
			});
			expect(response.status).toBe(400);
		}
		expect(context.principals).toEqual([]);
	});
});
