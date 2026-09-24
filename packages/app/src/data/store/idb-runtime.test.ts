/**
 * Runtime-owned IndexedDB factories isolate identical durable addresses.
 * Device and personal stores retain committed records when reopened
 * in the same factory, without changing the ambient browser factory.
 */
import { expect, test } from 'bun:test';
import { defineStore } from '@epicenter/app';
import { compileData } from '@epicenter/app/definition';
import { asPrincipalId } from '@epicenter/principal';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectOk } from 'wellcrafted/testing';
import { acquireStoreData } from './browser.js';

test.each([
	'local',
	'personal',
] as const)('%s stores isolate simultaneous factories and reopen their own committed records', async (scope) => {
	const appId = `so.epicenter.factory.${crypto.randomUUID()}`;
	const definition = expectOk(
		compileData(defineStore({ id: appId, kv: {}, tables: {} })),
	);
	const ambient = globalThis.indexedDB;
	const factories = [new IDBFactory(), new IDBFactory()];
	let online = true;
	const account = {
		authorityId: 'factory-test',
		principalId: asPrincipalId('alice'),
		baseURL: 'https://factory.test',
		async fetch(_input: RequestInfo | URL, init?: RequestInit) {
			if (!online) throw new Error('Offline reopen must use its own cache');
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
		async openWebSocket(): Promise<WebSocket> {
			throw new Error('Backing acquisition does not open a socket');
		},
	};
	const open = async (indexedDB: IDBFactory) =>
		expectOk(
			await acquireStoreData(
				definition,
				scope === 'local' ? { kind: 'local' } : { kind: 'personal', account },
				{ factory: indexedDB, keyRange: IDBKeyRange },
			),
		);
	const [first, second] = await Promise.all(factories.map(open));
	if (!first || !second) throw new Error('Both factories must open');
	try {
		await first.durable.commit([
			{
				kind: 'append',
				id: 2,
				bytes: first.loaded.updates[0]!,
				authoritySeq: undefined,
			},
		]);
		expect(second.loaded.lastId).toBe(1);
	} finally {
		await Promise.all([first.dispose?.(), second.dispose?.()]);
	}
	online = false;
	const reopened = await Promise.all(factories.map(open));
	try {
		expect(reopened.map((backing) => backing.loaded.lastId)).toEqual([2, 1]);
		expect(reopened.map((backing) => backing.loaded.outbox.length)).toEqual([
			1, 0,
		]);
		expect(globalThis.indexedDB).toBe(ambient);
	} finally {
		await Promise.all(reopened.map((backing) => backing.dispose?.()));
	}
});
