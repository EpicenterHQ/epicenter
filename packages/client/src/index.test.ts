/** ID-addressed immutable transport captures authority, bytes, and uncertain outcomes. */
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import {
	type BlobId,
	generateBlobId,
	MAX_REMOTE_BLOB_BYTES,
} from '@epicenter/blobs';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createRemoteBlobClient } from './index.js';

function setup(fetch?: Account['fetch']) {
	const requests: Request[] = [];
	const account = {
		baseURL: 'https://api.test',
		authorityId: 'authority',
		principalId: 'alice',
		fetch:
			fetch ??
			(async (input, init) => {
				requests.push(new Request(input, init));
				return Response.json(
					{
						id:
							new Headers(init?.headers).get(
								'x-epicenter-copy-destination-id',
							) ?? generateBlobId('bin'),
					},
					{ status: 201 },
				);
			}),
	} as Account;
	return {
		remote: createRemoteBlobClient({ appId: 'test.destination', account }),
		account,
		requests,
	};
}
test('creation returns a fresh ID under captured placement using one source snapshot', async () => {
	const c = setup();
	const id = generateBlobId('bin');
	let reads = 0;
	Object.assign(c.account, { baseURL: 'https://successor.test' });
	expectOk(
		await c.remote.copyFromLocal(
			{
				local: {
					async get() {
						reads++;
						return Ok(new Blob(['bytes']));
					},
				},
			},
			id,
		),
	);
	expect(reads).toBe(1);
	expect(c.requests[0]!.url).toBe(
		`https://api.test/api/apps/test.destination/principals/alice/blobs`,
	);
	expect(c.requests[0]!.method).toBe('POST');
	expect(await c.requests[0]!.text()).toBe('bytes');
});
test('native copy sends only source namespace and ID without reading the WebView', async () => {
	const c = setup();
	const id = generateBlobId('bin');
	expectOk(
		await c.remote.copyFromLocal(
			{
				nativeAppId: 'test.source',
				local: {
					async get() {
						throw new Error('materialized');
					},
				},
			},
			id,
		),
	);
	expect(c.requests[0]!.body).toBeNull();
	expect(c.requests[0]!.headers.get('x-epicenter-local-blob-app')).toBe(
		'test.source',
	);
	expect(c.requests[0]!.headers.get('x-epicenter-local-blob-id')).toBe(id);
});
test('bounded publication rejects oversized snapshots before sending bytes', async () => {
	const c = setup();

	expect(
		expectErr(
			await c.remote.add(new Blob([new Uint8Array(MAX_REMOTE_BLOB_BYTES + 1)])),
		).name,
	).toBe('TooLarge');
	expect(c.requests).toHaveLength(0);
});
test('arbitrary URLs and malformed IDs cannot select transport destinations', async () => {
	const c = setup();
	for (const invalid of [
		'https://evil.test',
		'blob_aaa',
		'../object',
		generateBlobId('bin') + '?signature=secret',
	]) {
		expect(expectErr(await c.remote.get(invalid as BlobId)).name).toBe(
			'Failed',
		);
		expect(expectErr(await c.remote.delete(invalid as BlobId)).name).toBe(
			'Failed',
		);
	}
	expect(c.requests).toHaveLength(0);
});
test('lost acknowledgments retain captured destination without inventing an ID', async () => {
	const c = setup(async () => {
		throw new Error('ack lost');
	});

	expect(expectErr(await c.remote.add(new Blob(['saved'])))).toMatchObject({
		name: 'PublicationUnconfirmed',
		destination: {
			namespace: 'test.destination',
			authorityId: 'authority',
			principalId: 'alice',
		},
	});
});
test('refused remote creation returns no invented destination ID and HTTP failure remains uncertain', async () => {
	for (const status of [409, 503]) {
		const c = setup(async () => new Response(null, { status }));
		expect(expectErr(await c.remote.add(new Blob(['x']))).name).toBe(
			'PublicationUnconfirmed',
		);
	}
});
test('cancellation reaches the captured Account and reports uncertain creation', async () => {
	const begun = Promise.withResolvers<void>();
	const abort = new AbortController();
	const c = setup(async (_, init) => {
		begun.resolve();
		return new Promise<Response>((_, reject) =>
			init!.signal!.addEventListener(
				'abort',
				() => reject(init!.signal!.reason),
				{ once: true },
			),
		);
	});

	const pending = c.remote.add(new Blob(['x']), { signal: abort.signal });
	await begun.promise;
	abort.abort();
	expect(expectErr(await pending)).toMatchObject({
		name: 'PublicationUnconfirmed',
	});
});
test('get returns computation bytes without publication', async () => {
	const c = setup(async () => new Response('bytes'));
	expect(await expectOk(await c.remote.get(generateBlobId('bin'))).text()).toBe(
		'bytes',
	);
});

test('native download requires a publication acknowledgment, not ordinary source bytes', async () => {
	const c = setup(async () => new Response('source bytes'));
	expectErr(
		await c.remote.copyToLocal(
			generateBlobId('bin'),
			'test.local',
			generateBlobId('bin'),
		),
	);
	const native = setup();
	expectOk(
		await native.remote.copyToLocal(
			generateBlobId('bin'),
			'test.local',
			generateBlobId('bin'),
		),
	);
	expect(native.requests[0]!.method).toBe('POST');
});

test('native receipt must confirm the requested destination ID', async () => {
	const c = setup(async () =>
		Response.json({ id: generateBlobId('bin') }, { status: 201 }),
	);
	expectErr(
		await c.remote.copyToLocal(
			generateBlobId('bin'),
			'test.local',
			generateBlobId('bin'),
		),
	);
});

test('native destination refusal preserves a definite collision receipt', async () => {
	const c = setup(async () => new Response(null, { status: 409 }));
	const id = generateBlobId('bin');
	expect(
		expectErr(
			await c.remote.copyToLocal(generateBlobId('bin'), 'test.local', id),
		),
	).toMatchObject({ name: 'BlobAlreadyExists', id });
});
