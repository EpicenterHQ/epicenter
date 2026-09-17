/**
 * WebView local blob adapter tests.
 * Verifies app-local routes, authenticated transport, metadata validation,
 * immutable write errors, and disposable playback without account selectors.
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { generateBlobId } from './blob-id.js';
import type { BlobStoreError } from './blob-store.js';
import { BLOB_PATHS, createWebviewBlobs } from './webview.js';

function setup(responses: Response[]) {
	const requests: Request[] = [];
	const inits: RequestInit[] = [];
	const options = {
		appId: 'so.epicenter.test',
		async fetch(input: RequestInfo | URL, init?: RequestInit) {
			inits.push(init ?? {});
			requests.push(
				new Request(new URL(String(input), 'http://localhost'), init),
			);
			const response = responses.shift();
			if (!response) throw new Error('Unexpected HTTP request');
			return response;
		},
	};
	return { ...createWebviewBlobs(options), options, requests, inits };
}

function metadata(size = 5, contentType = 'audio/wav') {
	return new Response(null, {
		headers: { 'content-length': String(size), 'content-type': contentType },
	});
}

test('all local operations retain the app selected at construction', async () => {
	const id = generateBlobId('wav');
	const { local, sources, options, requests, inits } = setup([
		new Response(null, { status: 204 }),
		new Response('audio'),
		metadata(),
		metadata(),
		new Response(null, { status: 204 }),
		new Response(null, { status: 204 }),
	]);
	options.appId = 'so.epicenter.other';
	expectOk(await local.put(id, new Blob(['audio'])));
	expect(await expectOk(await local.get(id)).text()).toBe('audio');
	expect(expectOk(await local.stat(id))).toEqual({
		size: 5,
		contentType: 'audio/wav',
	});
	const source = expectOk(await sources.open(id));
	expect(source.url).toBe(`/api/apps/so.epicenter.test/blobs/${id}`);
	source[Symbol.dispose]();
	source[Symbol.dispose]();
	expectOk(await local.delete(id));
	expect(requests.map((request) => request.method)).toEqual([
		'PUT',
		'GET',
		'HEAD',
		'HEAD',
		'DELETE',
	]);
	for (const request of requests) {
		expect(request.url).toContain('/api/apps/so.epicenter.test/blobs/');
	}
	for (const init of inits) {
		expect(init.credentials).toBe('same-origin');
		expect(init.redirect).toBe('error');
	}
	expect(BLOB_PATHS).toEqual({ local: '/api/apps/:appId/blobs' });
});

test('invalid application IDs fail before fetching', () => {
	for (const appId of [
		'',
		'app',
		'../other',
		' so.epicenter.test',
		'so.epicenter.test/other',
	])
		expect(() => createWebviewBlobs({ appId })).toThrow();
});

test('list sends exclusive pagination and accepts only ordered complete metadata', async () => {
	const ids = [
		generateBlobId('wav'),
		generateBlobId('wav'),
		generateBlobId('wav'),
	].sort();
	const items = [{ id: ids[1]!, size: 12, contentType: 'audio/wav' }];
	const { local, requests } = setup([
		Response.json({ items, nextCursor: ids[1] }),
	]);
	expect(expectOk(await local.list({ cursor: ids[0], limit: 1 }))).toEqual({
		items,
		nextCursor: ids[1],
	});
	const url = new URL(requests[0]!.url);
	expect(url.pathname).toBe('/api/apps/so.epicenter.test/blobs');
	expect(url.searchParams.get('cursor')).toBe(ids[0]!);
	expect(url.searchParams.get('limit')).toBe('1');
});

test('list rejects malformed results and invalid options', async () => {
	const id = generateBlobId('wav');
	for (const page of [
		{},
		{ items: [{ id, size: -1, contentType: 'audio/wav' }] },
		{ items: [{ id, size: 1, contentType: '' }] },
		{
			items: [
				{
					id: 'attachment.recordings.aaaaaaaaaaaaaaaaaaaaaaaa',
					size: 1,
					contentType: 'audio/wav',
				},
			],
		},
		{ items: [], nextCursor: id },
		{
			items: [
				{ id, size: 1, contentType: 'audio/wav' },
				{ id, size: 1, contentType: 'audio/wav' },
			],
		},
	]) {
		const { local } = setup([Response.json(page)]);
		expect(expectErr(await local.list()).name).toBe('BlobStoreFailed');
	}
	const { local, requests } = setup([]);
	for (const options of [
		{ cursor: '../escape' },
		{ limit: 0 },
		{ limit: 1001 },
	])
		expect(expectErr(await local.list(options)).name).toBe('BlobStoreFailed');
	expect(requests).toHaveLength(0);
});

test('missing bytes and immutable collisions keep typed errors', async () => {
	const id = generateBlobId('wav');
	const { local, sources } = setup([
		new Response(null, { status: 404 }),
		new Response(null, { status: 404 }),
		new Response(null, { status: 409 }),
		new Response(null, { status: 404 }),
	]);
	expect(expectErr(await local.get(id))).toMatchObject({
		name: 'BlobNotFound',
		id,
	});
	expect(expectErr(await local.stat(id))).toMatchObject({
		name: 'BlobNotFound',
		id,
	});
	expect(expectErr(await local.put(id, new Blob()))).toMatchObject({
		name: 'BlobAlreadyExists',
		id,
	});
	expect(expectErr(await sources.open(id))).toMatchObject({
		name: 'BlobNotFound',
		id,
	});
});

test('invalid HEAD metadata fails without creating a playback URL', async () => {
	for (const response of [
		new Response(),
		metadata(-1),
		metadata(1.5),
		metadata(5, ''),
	]) {
		const { sources } = setup([response]);
		expect(expectErr(await sources.open(generateBlobId('wav'))).name).toBe(
			'BlobStoreFailed',
		);
	}
});

test('transport and HTTP failures remain typed for each operation', async () => {
	const id = generateBlobId('wav');
	const { local } = setup(
		Array.from({ length: 7 }, () => new Response(null, { status: 500 })),
	);
	for (const operation of [
		() => local.get(id),
		() => local.stat(id),
		() => local.put(id, new Blob()),
		() => local.delete(id),
		() => local.list(),
	])
		expect(expectErr<BlobStoreError>(await operation()).name).toBe(
			'BlobStoreFailed',
		);
	const failing = createWebviewBlobs({
		appId: 'so.epicenter.test',
		fetch: async () => {
			throw new Error('offline');
		},
	});
	expect(expectErr(await failing.local.get(id)).name).toBe('BlobStoreFailed');
	expect(expectErr(await failing.local.list()).name).toBe('BlobStoreFailed');
});
