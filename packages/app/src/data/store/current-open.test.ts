import { defineApp } from '@epicenter/app';
import { compileData } from '@epicenter/app/definition';
/** Current startup installs canonical bytes, preserves offline outboxes by actor/library,
 * and returns to ordinary bootstrap after durable retirement invalidation. */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';

import { asPrincipalId } from '@epicenter/principal';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import * as Y from '@y/y';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { acquireAppData } from './browser.js';
import { createDatabaseDocument } from './document.js';

function fixture() {
	const appId = `so.epicenter.current.${crypto.randomUUID()}`;
	const definition = expectOk(
		compileData(defineApp({ id: appId, kv: {}, tables: {} })),
	);
	const doc = createDatabaseDocument();
	doc.get('proof').setAttr('canonical', 'server');
	const bytes = new Uint8Array(Y.encodeStateAsUpdateV2(doc));
	doc.destroy();
	let online = true;
	let calls = 0;
	let generation = 1;
	function options(actor: string, library: 'personal' | 'shared' = 'shared') {
		const account = {
			authorityId: 'server-a',
			principalId: asPrincipalId(actor),
		};
		return {
			appId,
			library,
			account: {
				...account,
				baseURL: 'https://server.test',
				async fetch() {
					calls++;
					if (!online) throw new Error('offline');
					return createCurrentDownloadResponse({
						generation,
						head: 1,
						snapshot: { position: 1, bytes },
						tail: [],
					});
				},
				async openWebSocket(): Promise<WebSocket> {
					throw new Error('No sockets in backing test');
				},
			},
		};
	}
	return {
		definition,
		options,
		bytes,
		calls: () => calls,
		offline: () => {
			online = false;
		},
		next: () => {
			online = true;
			generation++;
		},
	};
}

test('independent caches install canonical bytes and reopen offline without discovery', async () => {
	const f = fixture();
	const [alice, bob] = await Promise.all(
		['alice', 'bob'].map(async (actor) =>
			expectOk(
				await acquireAppData(f.definition, f.options(actor), {
					factory: indexedDB,
					keyRange: IDBKeyRange,
				}),
			),
		),
	);
	expect(alice!.loaded.updates).toEqual([f.bytes]);
	expect(bob!.loaded.updates).toEqual([f.bytes]);
	await alice!.dispose?.();
	await bob!.dispose?.();
	f.offline();
	const reopened = expectOk(
		await acquireAppData(f.definition, f.options('alice'), {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	);
	expect(reopened.loaded.updates).toEqual([f.bytes]);
	expect(f.calls()).toBe(2);
	await reopened.dispose?.();
});

test('Alice pending Shared edits cannot enter Bob Shared or Alice Personal', async () => {
	const f = fixture();
	const alice = expectOk(
		await acquireAppData(f.definition, f.options('alice'), {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	);
	await alice.durable.commit([
		{ kind: 'append', id: 2, bytes: f.bytes, authoritySeq: undefined },
	]);
	await alice.dispose?.();
	const bob = expectOk(
		await acquireAppData(f.definition, f.options('bob'), {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	);
	const personal = expectOk(
		await acquireAppData(f.definition, f.options('alice', 'personal'), {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	);
	expect(bob.loaded.outbox).toHaveLength(0);
	expect(personal.loaded.outbox).toHaveLength(0);
	await bob.dispose?.();
	await personal.dispose?.();
	f.offline();
	const again = expectOk(
		await acquireAppData(f.definition, f.options('alice'), {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	);
	expect(again.loaded.outbox).toHaveLength(1);
	await again.dispose?.();
});

test('retirement fences the backing and makes next startup download its replacement', async () => {
	const f = fixture();
	const old = expectOk(
		await acquireAppData(f.definition, f.options('alice'), {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	);
	const invalidation = old.discard!();
	await expect(
		old.durable.commit([
			{ kind: 'append', id: 2, bytes: f.bytes, authoritySeq: undefined },
		]),
	).rejects.toThrow('retired');
	await invalidation;
	await old.dispose?.();
	f.offline();
	expectErr(
		await acquireAppData(f.definition, f.options('alice'), {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	);
	f.next();
	const fresh = expectOk(
		await acquireAppData(f.definition, f.options('alice'), {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	);
	expect(fresh.replication?.address.generation).toBe(2);
	expect(fresh.loaded.outbox).toHaveLength(0);
	await fresh.dispose?.();
});

test('malformed download does not publish a usable cache', async () => {
	const f = fixture();
	const options = f.options('alice');
	options.account.fetch = async () =>
		new Response(f.bytes, { headers: { 'epicenter-generation': '1' } });
	expectErr(
		await acquireAppData(f.definition, options, {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	);
	const retry = expectOk(
		await acquireAppData(f.definition, f.options('alice'), {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	);
	expect(f.calls()).toBe(1);
	await retry.dispose?.();
});

test('startup installs the complete captured tail before local use and offline reopen', async () => {
	const f = fixture();
	const source = createDatabaseDocument();
	Y.applyUpdateV2(source, f.bytes);
	const tail: { seq: number; bytes: Uint8Array }[] = [];
	source.on('updateV2', (bytes: Uint8Array) => {
		tail.push({ seq: tail.length + 2, bytes });
	});
	for (let index = 1; index <= 130; index++)
		source.get('proof').setAttr(`accepted-${index}`, index);
	source.get('proof').deleteAttr('canonical');
	source.destroy();
	const options = f.options('alice');
	options.account.fetch = async () =>
		createCurrentDownloadResponse({
			generation: 1,
			head: 132,
			snapshot: { position: 1, bytes: f.bytes },
			tail,
		});
	const opened = expectOk(
		await acquireAppData(f.definition, options, {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	);
	expect(opened.loaded.cursor).toBe(132);
	expect(opened.loaded.outbox).toHaveLength(0);
	const installed = createDatabaseDocument();
	for (const bytes of opened.loaded.updates) Y.applyUpdateV2(installed, bytes);
	expect(installed.get('proof').getAttr('accepted-130')).toBe(130);
	expect(installed.get('proof').getAttr('canonical')).toBeUndefined();
	installed.destroy();
	await opened.dispose?.();
	f.offline();
	const reopened = expectOk(
		await acquireAppData(f.definition, f.options('alice'), {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	);
	expect(reopened.loaded).toEqual(opened.loaded);
	await reopened.dispose?.();
});

test('a truncated tail leaves no cache and a later complete download can retry', async () => {
	const f = fixture();
	const options = f.options('alice');
	options.account.fetch = async () => {
		const response = createCurrentDownloadResponse({
			generation: 1,
			head: 2,
			snapshot: { position: 1, bytes: f.bytes },
			tail: [{ seq: 2, bytes: f.bytes }],
		});
		const body = new Uint8Array(await response.arrayBuffer());
		return new Response(body.slice(0, -1), { headers: response.headers });
	};
	expectErr(
		await acquireAppData(f.definition, options, {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	);
	const retry = expectOk(
		await acquireAppData(f.definition, f.options('alice'), {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	);
	expect(f.calls()).toBe(1);
	expect(retry.loaded.cursor).toBe(1);
	await retry.dispose?.();
});

for (const pending of ['structs', 'deletes'] as const) {
	test(`unresolved ${pending} cannot publish a usable cache`, async () => {
		const f = fixture();
		const source = createDatabaseDocument();
		const parent = new Y.Type();
		source.get('proof').setAttr('unseen', parent);
		let delta = new Uint8Array();
		source.on('updateV2', (bytes: Uint8Array) => {
			delta = new Uint8Array(bytes);
		});
		if (pending === 'structs') parent.setAttr('later', true);
		else source.get('proof').deleteAttr('unseen');
		source.destroy();
		const options = f.options('alice');
		options.account.fetch = async () =>
			createCurrentDownloadResponse({
				generation: 1,
				head: 2,
				snapshot: { position: 1, bytes: f.bytes },
				tail: [{ seq: 2, bytes: delta }],
			});
		const error = expectErr(
			await acquireAppData(f.definition, options, {
				factory: indexedDB,
				keyRange: IDBKeyRange,
			}),
		);
		expect(error).toMatchObject({
			name: 'StorageFailed',
			cause: new Error(
				'Current library download has unresolved Yjs dependencies',
			),
		});
		const retry = expectOk(
			await acquireAppData(f.definition, f.options('alice'), {
				factory: indexedDB,
				keyRange: IDBKeyRange,
			}),
		);
		expect(f.calls()).toBe(1);
		await retry.dispose?.();
	});
}
