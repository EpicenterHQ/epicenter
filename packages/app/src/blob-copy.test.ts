/** Store copies create independent identities with identical bytes across scopes, and reject invented sources. */
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { generateBlobId } from '@epicenter/blobs';
import { asPrincipalId } from '@epicenter/principal';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { acquireLocalBlobs } from './blob-owner.js';
import type { LocalBlobs } from './blobs.js';
import { defineApp } from './index.js';
import { openLocal, openPersonal } from './open-store.js';
import { createMemoryStoreRuntime } from './testing.js';

function setup() {
	const objects = new Map<string, Blob>();
	const account: Account = {
		authorityId: 'server',
		principalId: asPrincipalId('alice'),
		baseURL: 'https://copy.test',
		async fetch(input, init) {
			const request = new Request(input, init);
			if (new URL(request.url).pathname.endsWith('/current'))
				return createCurrentDownloadResponse({
					generation: 1,
					head: 1,
					snapshot: {
						position: 1,
						bytes: new Uint8Array(await request.arrayBuffer()),
					},
					tail: [],
				});
			if (request.method === 'POST') {
				const body = await request.blob();
				const url = request.url + '/' + generateBlobId('bin');
				objects.set(url, body);
				return Response.json({ id: url.split('/').at(-1) }, { status: 201 });
			}
			if (request.method === 'DELETE') {
				objects.delete(request.url);
				return new Response(null, { status: 204 });
			}
			const body = objects.get(request.url);
			return body ? new Response(body) : new Response(null, { status: 404 });
		},
		async openWebSocket() {
			return Object.assign(new EventTarget(), {
				readyState: 0,
				send() {},
				close() {},
			}) as unknown as WebSocket;
		},
		async getProfile() {
			throw new Error('unused');
		},
	};
	const definition = (id: string) => defineApp({ id, tables: {}, kv: {} });
	return { runtime: createMemoryStoreRuntime(), account, objects, definition };
}

test('all three directions create fresh IDs and preserve bytes across definitions', async () => {
	const c = setup();
	const a = await openLocal(c.definition('test.a'), { runtime: c.runtime });
	const b = await openLocal(c.definition('test.b'), { runtime: c.runtime });
	const personal = await openPersonal(c.definition('test.personal'), {
		runtime: c.runtime,
		account: c.account,
	});
	const source = expectOk(await a.blobs.add(new Blob(['snapshot'])));
	const localCopy = expectOk(await b.blobs.copyFrom(a.blobs, source));
	const remoteCopy = expectOk(await personal.blobs.copyFrom(a.blobs, source));
	const download = expectOk(await b.blobs.copyFrom(personal.blobs, remoteCopy));
	const repeated = expectOk(await personal.blobs.copyFrom(a.blobs, source));
	expect(
		new Set([source, localCopy, remoteCopy, download, repeated]).size,
	).toBe(5);
	for (const id of [localCopy, download])
		expect(await expectOk(await b.blobs.get(id)).text()).toBe('snapshot');
	expect(await expectOk(await a.blobs.get(source)).text()).toBe('snapshot');
	expectOk(await a.blobs.delete(source));
	expect(await expectOk(await personal.blobs.get(remoteCopy)).text()).toBe(
		'snapshot',
	);
	await Promise.all([a.close(), b.close(), personal.close()]);
	await c.runtime.dispose();
});

test('Personal add needs no Local placement and uncertain acknowledgment retains placement', async () => {
	const c = setup();
	const personal = await openPersonal(c.definition('test.personal'), {
		runtime: c.runtime,
		account: c.account,
	});
	const id = expectOk(await personal.blobs.add(new Blob(['remote only'])));
	expect(await expectOk(await personal.blobs.get(id)).text()).toBe(
		'remote only',
	);
	await personal.close();
	const original = c.account.fetch;
	c.account.fetch = async (input, init) => {
		const response = await original(input, init);
		if (init?.method === 'POST') throw new Error('lost acknowledgment');
		return response;
	};
	const reopened = await openPersonal(c.definition('test.personal'), {
		runtime: c.runtime,
		account: c.account,
	});
	const failed = expectErr(await reopened.blobs.add(new Blob(['uncertain'])));
	expect(failed).toMatchObject({
		name: 'PublicationUnconfirmed',
		destination: {
			namespace: 'test.personal',
			principalId: 'alice',
			authorityId: 'server',
		},
	});
	if (failed.name !== 'PublicationUnconfirmed')
		throw new Error('expected receipt');
	expect('id' in failed).toBe(false);
	expect(c.objects.size).toBe(2);
	expectErr(await reopened.blobs.add(new Blob(['uncertain'])));
	expect(c.objects.size).toBe(3);
	await reopened.close();
	await c.runtime.dispose();
});

test('structural fakes and unsupported Personal sources are rejected before transfer', async () => {
	const c = setup();
	const local = await openLocal(c.definition('test.local'), {
		runtime: c.runtime,
	});
	const personal = await openPersonal(c.definition('test.personal'), {
		runtime: c.runtime,
		account: c.account,
	});
	const fake = {
		get() {
			throw new Error('fake called');
		},
	} as unknown as LocalBlobs;
	const id = generateBlobId('bin');
	expect(() => local.blobs.copyFrom(fake, id)).toThrow('store-owned');
	expect(() => personal.blobs.copyFrom(fake, id)).toThrow('LocalBlobs');
	expect(() =>
		personal.blobs.copyFrom(personal.blobs as unknown as LocalBlobs, id),
	).toThrow('LocalBlobs');
	await Promise.all([local.close(), personal.close()]);
	await c.runtime.dispose();
});

test('a definite native destination collision permits both stores to close', async () => {
	const f = setup();
	const originalFetch = globalThis.fetch;
	const tauri = Object.getOwnPropertyDescriptor(globalThis, 'isTauri');
	Object.defineProperty(globalThis, 'isTauri', {
		configurable: true,
		value: true,
	});
	globalThis.fetch = Object.assign(async () => Response.json({ items: [] }), {
		preconnect: originalFetch.preconnect,
	});
	const originalAccountFetch = f.account.fetch;
	f.account.fetch = async (input, init) =>
		new Headers(init?.headers).has('x-epicenter-copy-destination-id')
			? new Response(null, { status: 409 })
			: originalAccountFetch(input, init);
	try {
		const local = await openLocal(f.definition('test.native'), {
			runtime: {
				...f.runtime,
				localBlobs: (id, assertUsable) =>
					acquireLocalBlobs({ id, assertUsable }),
			},
		});
		const personal = await openPersonal(f.definition('test.personal'), {
			account: f.account,
			runtime: f.runtime,
		});
		expect(
			expectErr(
				await local.blobs.copyFrom(personal.blobs, generateBlobId('bin')),
			).name,
		).toBe('BlobAlreadyExists');
		await expect(local.close()).resolves.toBeUndefined();
		await expect(personal.close()).resolves.toBeUndefined();
	} finally {
		globalThis.fetch = originalFetch;
		if (tauri) Object.defineProperty(globalThis, 'isTauri', tauri);
		else Reflect.deleteProperty(globalThis, 'isTauri');
	}
});
