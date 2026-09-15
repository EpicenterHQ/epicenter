/**
 * One-shot signed byte transfers through actual HTTP and independent stores.
 * Verification precedes publication; retries preserve origin, cancellation and
 * oversized streams leave no completed local object, and HTTP conflicts remain failures.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { attachmentContent } from './attachment-content.js';
import { attachmentStorageId } from './attachment-key.js';
import { createBrowserBlobStore } from './browser.js';
import { createBunBlobStore } from './bun.js';

const cleanup: string[] = [];
afterEach(async () => {
	for (const directory of cleanup.splice(0))
		await rm(directory, { recursive: true, force: true });
});
const id = attachmentStorageId('recordings', 'a'.repeat(24));
const signal = () => new AbortController().signal;

for (const platform of ['browser', 'bun'] as const) {
	test(`${platform}: signed upload/download verifies HTTP bytes and preserves origin on identical races`, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'transfer-'));
		cleanup.push(directory);
		const indexedDb = new IDBFactory();
		const open = () =>
			platform === 'bun'
				? createBunBlobStore({ directory })
				: createBrowserBlobStore({
						appId: 'test.transfer',
						replica: {
							library: 'personal',
							account: {
								authorityId: 'test',
								principalId: asPrincipalId('alice'),
							},
						},
						indexedDb,
						locks: {
							request: async (_name, _options, callback) => callback({}),
						},
					});
		const file = new Blob(['original bytes'], { type: 'audio/wav' });
		const expected = await attachmentContent(file);
		let body = file;
		let uploadStatus = 204;
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			async fetch(request) {
				if (request.method === 'PUT') {
					expect(request.headers.get('authorization')).toBeNull();
					expect(request.headers.get('cookie')).toBeNull();
					expect(await request.text()).toBe('original bytes');
					return new Response(null, { status: uploadStatus });
				}
				return new Response(body);
			},
		});
		const ticket = {
			url: server.url.href,
			requiredHeaders: { 'content-type': file.type, 'if-none-match': '*' },
		};
		try {
			expectOk(
				await open().attachments!.download(id, expected, ticket, signal()),
			);
			expect(expectOk(await open().stat(id)).attachment).toEqual({
				...expected,
				pendingUpload: false,
			});
			expectOk(
				await open().attachments!.upload(id, expected, ticket, signal()),
			);
			for (const status of [409, 412]) {
				uploadStatus = status;
				expect(
					expectErr(
						await open().attachments!.upload(id, expected, ticket, signal()),
					),
				).toMatchObject({ kind: 'transport', status });
			}
			const localId = attachmentStorageId('recordings', 'b'.repeat(24));
			expectOk(await open().attachments!.put(localId, file, 7));
			expectOk(
				await open().attachments!.download(localId, expected, ticket, signal()),
			);
			expect(expectOk(await open().stat(localId)).attachment).toMatchObject({
				originGeneration: 7,
				pendingUpload: true,
			});
			expectOk(await open().attachments!.acknowledge(localId, expected, 7));
			expectOk(
				await open().attachments!.download(localId, expected, ticket, signal()),
			);
			expect(expectOk(await open().stat(localId)).attachment).toMatchObject({
				originGeneration: 7,
				pendingUpload: false,
			});
			body = new Blob(['different byte'], { type: file.type });
			const absent = attachmentStorageId('recordings', 'c'.repeat(24));
			expect(
				expectErr(
					await open().attachments!.download(
						absent,
						expected,
						ticket,
						signal(),
					),
				),
			).toMatchObject({ kind: 'conflict', status: 409 });
			expect(expectErr(await open().stat(absent)).name).toBe('BlobNotFound');
			body = new Blob(['original bytes plus overflow'], { type: file.type });
			expect(
				expectErr(
					await open().attachments!.download(
						absent,
						expected,
						ticket,
						signal(),
					),
				),
			).toMatchObject({ kind: 'conflict', status: 409 });
			expect(expectErr(await open().stat(absent)).name).toBe('BlobNotFound');
		} finally {
			await server.stop(true);
		}
	});
}

test('Bun retries a lost upload response against actual HTTP without accepting a conflicting response', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'transfer-lost-'));
	cleanup.push(directory);
	const store = createBunBlobStore({ directory });
	const file = new Blob(['saved'], { type: 'audio/wav' });
	const expected = expectOk(await store.attachments.put(id, file, 1));
	let received = 0;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			expect(await request.text()).toBe('saved');
			return new Response(null, { status: ++received === 1 ? 204 : 412 });
		},
	});
	const actualFetch = globalThis.fetch;
	let lose = true;
	const spy = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(
			async (...args: Parameters<typeof fetch>) => {
				const response = await actualFetch(...args);
				if (lose) {
					lose = false;
					throw new Error('Response lost after server accepted bytes');
				}
				return response;
			},
			{ preconnect: actualFetch.preconnect },
		),
	);
	try {
		const ticket = {
			url: server.url.href,
			requiredHeaders: { 'content-type': file.type, 'if-none-match': '*' },
		};
		expect(
			expectErr(await store.attachments.upload(id, expected, ticket, signal()))
				.kind,
		).toBe('transport');
		expect(
			expectErr(await store.attachments.upload(id, expected, ticket, signal())),
		).toMatchObject({ kind: 'transport', status: 412 });
		expect(expectOk(await store.stat(id)).attachment?.pendingUpload).toBe(true);
		expect(received).toBe(2);
	} finally {
		spy.mockRestore();
		await server.stop(true);
	}
});

test('Bun refuses corrupt local uploads, conflicting occupied downloads, and blocked storage', async () => {
	const root = await mkdtemp(join(tmpdir(), 'transfer-errors-'));
	cleanup.push(root);
	const directory = join(root, 'store');
	const store = createBunBlobStore({ directory });
	const file = new Blob(['original'], { type: 'audio/wav' });
	const expected = expectOk(await store.attachments.put(id, file, 3));
	let calls = 0;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch() {
			calls++;
			return new Response(file);
		},
	});
	try {
		await Bun.write(join(directory, id, 'data'), 'tampered');
		expect(
			expectErr(
				await store.attachments.upload(
					id,
					expected,
					{ url: server.url.href, requiredHeaders: {} },
					signal(),
				),
			).kind,
		).toBe('conflict');
		expect(calls).toBe(0);
		expect(
			expectErr(
				await store.attachments.download(
					id,
					expected,
					{ url: server.url.href },
					signal(),
				),
			).kind,
		).toBe('conflict');
		expect(await Bun.file(join(directory, id, 'data')).text()).toBe('tampered');
		const blocked = join(root, 'blocked');
		await Bun.write(blocked, 'not a directory');
		expect(
			expectErr(
				await createBunBlobStore({ directory: blocked }).attachments.download(
					id,
					expected,
					{ url: server.url.href },
					signal(),
				),
			).kind,
		).toBe('storage');
		expect(await readdir(join(directory, '.staging', 'bun'))).toEqual([]);
	} finally {
		await server.stop(true);
	}
});

test('Bun streams a 172800044-byte HTTP download and upload without whole-file byte readers', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'transfer-large-'));
	cleanup.push(directory);
	const size = 172_800_044;
	const chunk = new Uint8Array(64 * 1024).fill(42);
	const hash = createHash('sha256');
	for (let offset = 0; offset < size; offset += chunk.length)
		hash.update(chunk.subarray(0, Math.min(chunk.length, size - offset)));
	const expected = {
		sha256: hash.digest('hex'),
		size,
		contentType: 'audio/wav',
	};
	let uploaded = 0;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		maxRequestBodySize: size + 1,
		async fetch(request) {
			if (request.method === 'PUT') {
				const reader = request.body!.getReader();
				while (true) {
					const part = await reader.read();
					if (part.done) break;
					uploaded += part.value.length;
				}
				return new Response(null, { status: 204 });
			}
			let remaining = size;
			return new Response(
				new ReadableStream({
					pull(controller) {
						if (!remaining) return controller.close();
						const length = Math.min(chunk.length, remaining);
						remaining -= length;
						controller.enqueue(chunk.slice(0, length));
					},
				}),
				{ headers: { 'content-type': expected.contentType } },
			);
		},
	});
	const spy = spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(() => {
		throw new Error('Whole-file byte readers forbidden');
	});
	try {
		const store = createBunBlobStore({ directory });
		expectOk(
			await store.attachments.download(
				id,
				expected,
				{ url: server.url.href },
				signal(),
			),
		);
		expectOk(
			await store.attachments.upload(
				id,
				expected,
				{
					url: server.url.href,
					requiredHeaders: {
						'content-type': expected.contentType,
						'if-none-match': '*',
					},
				},
				signal(),
			),
		);
		expect(uploaded).toBe(size);
		expect(expectOk(await store.stat(id)).attachment?.pendingUpload).toBe(
			false,
		);
	} finally {
		spy.mockRestore();
		await server.stop(true);
	}
});

test('Bun cancellation removes a partial large download and leaves no completed object', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'transfer-cancel-'));
	cleanup.push(directory);
	const started = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch() {
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(64 * 1024));
						started.resolve();
					},
				}),
				{ headers: { 'content-type': 'audio/wav' } },
			);
		},
	});
	try {
		const store = createBunBlobStore({ directory });
		const abort = new AbortController();
		const pending = store.attachments.download(
			id,
			{ sha256: '0'.repeat(64), size: 172_800_044, contentType: 'audio/wav' },
			{ url: server.url.href },
			abort.signal,
		);
		await started.promise;
		abort.abort();
		expect(expectErr(await pending).kind).toBe('transport');
		expect(expectErr(await store.stat(id)).name).toBe('BlobNotFound');
		expect(
			await readdir(join(directory, '.staging', 'bun')).catch(() => []),
		).toEqual([]);
	} finally {
		await server.stop(true);
	}
});
