/**
 * Runtime-owned IndexedDB factories isolate identical durable addresses.
 * Local, personal, and shared libraries retain committed records when reopened
 * in the same factory, without changing the ambient browser factory.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { defineApp } from '@epicenter/app';
import { compileData } from '@epicenter/app/definition';
import { asPrincipalId } from '@epicenter/principal';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { IDBFactory } from 'fake-indexeddb';
import { expectOk } from 'wellcrafted/testing';
import { acquireAppData } from './browser.js';

test.each([
	'local',
	'personal',
	'shared',
] as const)('%s libraries isolate simultaneous factories and reopen their own committed records', async (library) => {
	const appId = `so.epicenter.factory.${crypto.randomUUID()}`;
	const definition = expectOk(
		compileData(defineApp({ id: appId, kv: {}, tables: {} })),
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
			await acquireAppData(definition, { appId, library, account, indexedDB }),
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
		expect(
			(await ambient.databases()).some(({ name }) => name?.includes(appId)),
		).toBe(false);
	} finally {
		await Promise.all(reopened.map((backing) => backing.dispose?.()));
	}
});
