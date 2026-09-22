/** Explicit stores fix identity, exclude duplicate writers, and close independently. */
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { generateBlobId } from '@epicenter/blobs';
import { appClaimAddress } from '@epicenter/device/app-claim';
import { asPrincipalId } from '@epicenter/principal';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { StoreError } from './data/store/store.js';
import { defineApp, defineTable, field } from './index.js';
import { openLocal, openPersonal } from './open-store.js';
import { createMemoryStoreRuntime } from './testing.js';

const definition = defineApp({
	id: 'test.independent-stores',
	kv: {},
	tables: { notes: defineTable({ title: field.string() }) },
});
function accountFor(principalId = 'alice', authorityId = 'test'): Account {
	return {
		authorityId,
		principalId: asPrincipalId(principalId),
		baseURL: 'https://stores.test',
		async fetch(_input, init) {
			return createCurrentDownloadResponse({
				generation: 1,
				head: 1,
				snapshot: {
					position: 1,
					bytes: new Uint8Array(await new Response(init?.body).arrayBuffer()),
				},
				tail: [],
			});
		},
		async openWebSocket() {
			return Object.assign(new EventTarget(), {
				readyState: 0,
				close() {},
				send() {},
			}) as unknown as WebSocket;
		},
		async getProfile() {
			throw new Error('Unused');
		},
	};
}

test('Local and Personal coexist, isolate owners, and close in either order', async () => {
	const runtime = createMemoryStoreRuntime();
	const local = await openLocal(definition, { runtime });
	local.tables.notes.create({ title: 'local' });
	for (const account of [
		accountFor(),
		accountFor('bob'),
		accountFor('alice', 'other'),
	]) {
		const personal = await openPersonal(definition, { account, runtime });
		expect(personal.tables.notes.rows).toEqual([]);
		personal.tables.notes.create({
			title: account.authorityId + account.principalId,
		});
		await expect(
			openPersonal(definition, { account, runtime }),
		).rejects.toMatchObject({ name: 'AlreadyOpen' });
		const closing = personal.close();
		expect(personal.close()).toBe(closing);
		await closing;
		expect(() => personal.tables.notes.rows).toThrow();
		expect(() => personal.persistence).toThrow();
		expect(local.tables.notes.rows[0]!.title).toBe('local');
	}
	const personal = await openPersonal(definition, {
		account: accountFor(),
		runtime,
	});
	await local.close();
	expect(personal.tables.notes.rows[0]!.title).toBe('testalice');
	const reopened = await openLocal(definition, { runtime });
	expect(reopened.tables.notes.rows[0]!.title).toBe('local');
	await reopened.close();
	await personal.close();
	await runtime.dispose();
});

test('Personal snapshots identity and transport before pending admission', async () => {
	const runtime = createMemoryStoreRuntime();
	const gate = Promise.withResolvers<void>();
	const account = accountFor();
	const opening = openPersonal(definition, {
		account,
		runtime: {
			...runtime,
			async claim(address) {
				const result = await runtime.claim(address);
				await gate.promise;
				return result;
			},
		},
	});
	await expect(
		openPersonal(definition, { account, runtime }),
	).rejects.toMatchObject({ name: 'AlreadyOpen' });
	await expect(runtime.dispose()).rejects.toThrow('open stores');
	Object.assign(account, {
		principalId: asPrincipalId('bob'),
		fetch() {
			throw new Error('Retargeted');
		},
	});
	gate.resolve();
	const personal = await opening;
	expect(personal.identity.principalId).toBe(asPrincipalId('alice'));
	expect(Object.isFrozen(personal.identity)).toBe(true);
	await personal.close();
	await runtime.dispose();
});

test('existing document admission excludes duplicate standalone owners', async () => {
	const runtime = createMemoryStoreRuntime();
	for (const account of [undefined, accountFor()]) {
		const legacy = expectOk(
			await runtime.claim(appClaimAddress(definition.id, account)),
		);
		await expect(
			account
				? openPersonal(definition, { account, runtime })
				: openLocal(definition, { runtime }),
		).rejects.toMatchObject({ name: 'AlreadyOpen' });
		legacy.release();
	}
	await runtime.dispose();
});

test('returned opening failure releases ownership, thrown acquisition retains it', async () => {
	for (const throws of [false, true]) {
		const runtime = createMemoryStoreRuntime();
		const local = await openLocal(definition, { runtime });
		const account = accountFor();
		await expect(
			openPersonal(definition, {
				account,
				runtime: {
					...runtime,
					async data() {
						if (throws) throw new Error('Uncertain release');
						return StoreError.StorageFailed({
							cause: new Error('Rolled back'),
						});
					},
				},
			}),
		).rejects.toBeDefined();
		local.tables.notes.create({ title: 'still open' });
		await local.close();
		if (throws) {
			await expect(
				openPersonal(definition, { account, runtime }),
			).rejects.toMatchObject({ name: 'AlreadyOpen' });
			await expect(runtime.dispose()).rejects.toThrow('open stores');
		} else {
			const personal = await openPersonal(definition, { account, runtime });
			await personal.close();
			await runtime.dispose();
		}
	}
});

test('failed Personal cleanup retains its claim without retiring Local', async () => {
	const runtime = createMemoryStoreRuntime();
	const local = await openLocal(definition, { runtime });
	const account = accountFor();
	const personal = await openPersonal(definition, {
		account,
		runtime: {
			...runtime,
			async data(...args) {
				const backing = expectOk(await runtime.data(...args));
				return Ok({
					...backing,
					async dispose() {
						await backing.dispose?.();
						throw new Error('Cleanup failed');
					},
				});
			},
		},
	});
	await expect(personal.close()).rejects.toThrow('Cleanup failed');
	local.tables.notes.create({ title: 'still open' });
	await expect(
		openPersonal(definition, { account, runtime }),
	).rejects.toMatchObject({ name: 'AlreadyOpen' });
	await local.close();
	await expect(runtime.dispose()).rejects.toThrow('open stores');
});

test('cached Personal opens without blob probes and fences remote methods inside abort callbacks', async () => {
	const runtime = createMemoryStoreRuntime();
	const account = accountFor();
	const first = await openPersonal(definition, { account, runtime });
	await first.close();
	let probes = 0;
	account.fetch = async () => {
		probes++;
		throw new Error('offline');
	};
	const personal = await openPersonal(definition, { account, runtime });
	expect(probes).toBe(0);
	let refused = false;
	personal.signal.addEventListener('abort', () => {
		try {
			void personal.blobs.get(generateBlobId('bin'));
		} catch {
			refused = true;
		}
	});
	await personal.close();
	expect(refused).toBe(true);
	expect(probes).toBe(0);
	await runtime.dispose();
});
