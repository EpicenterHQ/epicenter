/**
 * Direct blob client tests.
 * Uploads use the captured Account, saved native bytes stay outside the WebView,
 * and owner-pinned URLs cannot redirect credentials or reinterpret ownership.
 */
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import {
	type BlobStore,
	generateBlobId,
	MAX_REMOTE_BLOB_BYTES,
	REMOTE_BLOB_ROUTES,
} from '@epicenter/blobs';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createRemoteBlobClient } from './index.js';

const appId = 'so.epicenter.notes';
const baseURL = 'https://api.example.test';
const url = REMOTE_BLOB_ROUTES.objectUrl(
	baseURL,
	appId,
	'alice',
	generateBlobId('bin'),
);
function setup({
	host = false,
	size = 5,
	response = () => Response.json({ url }),
	transport,
}: {
	host?: boolean;
	size?: number;
	response?: () => Response;
	transport?: Account['fetch'];
} = {}) {
	const calls: Request[] = [];
	let reads = 0;
	const account = {
		baseURL,
		principalId: 'alice',
		authorityId: 'server',
		fetch:
			transport ??
			(async (input, init) => {
				calls.push(new Request(input, init));
				return response();
			}),
	} as Account;
	const local: Pick<BlobStore, 'get' | 'stat'> = {
		async stat() {
			return Ok({ size, contentType: 'text/plain' });
		},
		async get() {
			reads++;
			return Ok(new Blob(['bytes'], { type: 'text/plain' }));
		},
	};
	return {
		remote: createRemoteBlobClient({ appId, account, local, host }),
		calls,
		get reads() {
			return reads;
		},
	};
}

test('add sends bytes directly through Account and returns the owner-pinned URL', async () => {
	const context = setup();
	expect(expectOk(await context.remote.add(new Blob(['image'])))).toBe(url);
	expect(context.calls).toHaveLength(1);
	expect(context.calls[0]!.url).toBe(`${baseURL}/api/apps/${appId}/blobs`);
	expect(await context.calls[0]!.text()).toBe('image');
	expect(context.reads).toBe(0);
});

test('oversized saved files are rejected before reading or issuing requests', async () => {
	for (const host of [false, true]) {
		const context = setup({ host, size: MAX_REMOTE_BLOB_BYTES + 1 });
		expect(
			expectErr(await context.remote.addLocal(generateBlobId('bin'))).name,
		).toBe('TooLarge');
		expect(context.reads).toBe(0);
		expect(context.calls).toHaveLength(0);
	}
});

test('host addLocal sends only a source ID through the captured Account', async () => {
	const context = setup({ host: true });
	const id = generateBlobId('bin');
	expect(expectOk(await context.remote.addLocal(id))).toBe(url);
	expect(context.reads).toBe(0);
	expect(context.calls[0]!.headers.get('x-epicenter-local-blob-id')).toBe(id);
	expect(context.calls[0]!.body).toBeNull();
});

test('browser addLocal reads the saved Blob and uploads without changing its local ID', async () => {
	const context = setup();
	expect(expectOk(await context.remote.addLocal(generateBlobId('bin')))).toBe(
		url,
	);
	expect(context.reads).toBe(1);
	expect(await context.calls[0]!.text()).toBe('bytes');
});

test('foreign owners, applications, origins and signed query URLs are refused before fetch', async () => {
	const context = setup();
	for (const foreign of [
		url.replace('alice', 'bob'),
		url.replace(appId, 'so.epicenter.other'),
		url.replace('api.example.test', 'evil.test'),
		`${url}?signature=secret`,
		url.replace(/\.[^.]+$/, ''),
		url.replace('.bin', '%2ebin'),
	]) {
		expect(expectErr(await context.remote.get(foreign)).name).toBe(
			'InvalidUrl',
		);
		expect(expectErr(await context.remote.delete(foreign)).name).toBe(
			'InvalidUrl',
		);
	}
	expect(context.calls).toHaveLength(0);
});

test('malformed upload responses and request failures return Results', async () => {
	for (const response of [
		() => new Response('invalid json'),
		() => Response.json({ url: url.replace('alice', 'bob') }),
		() => new Response(null, { status: 401 }),
	]) {
		expect(
			expectErr(await setup({ response }).remote.add(new Blob())).name,
		).toBe('Failed');
	}
});

test('get returns a Blob and open creates an independently disposable playback URL', async () => {
	const context = setup({
		response: () =>
			new Response('audio', { headers: { 'content-type': 'audio/wav' } }),
	});
	expect(await expectOk(await context.remote.get(url)).text()).toBe('audio');
	const first = expectOk(await context.remote.open(url));
	const second = expectOk(await context.remote.open(url));
	expect(first.url).not.toBe(second.url);
	first[Symbol.dispose]();
	first[Symbol.dispose]();
	expect(await (await fetch(second.url)).text()).toBe('audio');
	second[Symbol.dispose]();
});

test('cancellation reaches the actual Account request and is returned as an error', async () => {
	const started = Promise.withResolvers<void>();
	const controller = new AbortController();
	const context = setup({
		transport: async (_input, init) => {
			started.resolve();
			return new Promise<Response>((_resolve, reject) =>
				init?.signal?.addEventListener(
					'abort',
					() => reject(init.signal?.reason),
					{ once: true },
				),
			);
		},
	});
	const pending = context.remote.addLocal(generateBlobId('bin'), {
		signal: controller.signal,
	});
	await started.promise;
	controller.abort();
	expect(expectErr(await pending).name).toBe('Failed');
});
