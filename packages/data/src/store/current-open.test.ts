/** Current startup installs canonical bytes, preserves offline outboxes by actor/library,
 * and returns to ordinary bootstrap after durable retirement invalidation. */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { compileData, defineData } from '@epicenter/data/definition';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import * as Y from '@y/y';
import { acquireAppData } from './browser.js';
import { createDatabaseDocument } from './document.js';

function fixture() {
	const appId = `so.epicenter.current.${crypto.randomUUID()}`;
	const definition = expectOk(
		compileData(defineData({ id: appId, kv: {}, tables: {} })),
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
			replica: { library, account },
			remote: {
				currentUrl: `https://server.test/current/${library}`,
				address: { baseURL: 'https://server.test', appId, library },
				transport: {
					...account,
					baseURL: 'https://server.test',
					async fetch() {
						calls++;
						if (!online) throw new Error('offline');
						return new Response(bytes, {
							headers: {
								'epicenter-generation': String(generation),
								'epicenter-log-position': '1',
							},
						});
					},
					async openWebSocket(): Promise<WebSocket> {
						throw new Error('No sockets in backing test');
					},
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
			expectOk(await acquireAppData(f.definition, f.options(actor))),
		),
	);
	expect(alice!.loaded.updates).toEqual([f.bytes]);
	expect(bob!.loaded.updates).toEqual([f.bytes]);
	await alice!.dispose?.();
	await bob!.dispose?.();
	f.offline();
	const reopened = expectOk(
		await acquireAppData(f.definition, f.options('alice')),
	);
	expect(reopened.loaded.updates).toEqual([f.bytes]);
	expect(f.calls()).toBe(2);
	await reopened.dispose?.();
});

test('Alice pending Shared edits cannot enter Bob Shared or Alice Personal', async () => {
	const f = fixture();
	const alice = expectOk(
		await acquireAppData(f.definition, f.options('alice')),
	);
	await alice.durable.commit([
		{ kind: 'append', id: 2, bytes: f.bytes, authoritySeq: undefined },
	]);
	await alice.dispose?.();
	const bob = expectOk(await acquireAppData(f.definition, f.options('bob')));
	const personal = expectOk(
		await acquireAppData(f.definition, f.options('alice', 'personal')),
	);
	expect(bob.loaded.outbox).toHaveLength(0);
	expect(personal.loaded.outbox).toHaveLength(0);
	await bob.dispose?.();
	await personal.dispose?.();
	f.offline();
	const again = expectOk(
		await acquireAppData(f.definition, f.options('alice')),
	);
	expect(again.loaded.outbox).toHaveLength(1);
	await again.dispose?.();
});

test('retirement fences the backing and makes next startup download its replacement', async () => {
	const f = fixture();
	const old = expectOk(await acquireAppData(f.definition, f.options('alice')));
	const invalidation = old.discard!();
	await expect(
		old.durable.commit([
			{ kind: 'append', id: 2, bytes: f.bytes, authoritySeq: undefined },
		]),
	).rejects.toThrow('retired');
	await invalidation;
	await old.dispose?.();
	f.offline();
	expectErr(await acquireAppData(f.definition, f.options('alice')));
	f.next();
	const fresh = expectOk(
		await acquireAppData(f.definition, f.options('alice')),
	);
	expect(fresh.replication?.address.generation).toBe(2);
	expect(fresh.loaded.outbox).toHaveLength(0);
	await fresh.dispose?.();
});

test('malformed download does not publish a usable cache', async () => {
	const f = fixture();
	const options = f.options('alice');
	options.remote.transport.fetch = async () =>
		new Response(f.bytes, { headers: { 'epicenter-generation': '1' } });
	expectErr(await acquireAppData(f.definition, options));
	const retry = expectOk(
		await acquireAppData(f.definition, f.options('alice')),
	);
	expect(f.calls()).toBe(1);
	await retry.dispose?.();
});
