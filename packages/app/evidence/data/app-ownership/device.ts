/** Independent process: its own IndexedDB factory and current-scope cache. */
import { defineStore } from '@epicenter/app';
import 'fake-indexeddb/auto';
import { asPrincipalId } from '@epicenter/principal';
import { expectOk } from 'wellcrafted/testing';
import { compileData } from '../../../src/data/definition/index.js';
import { acquireStoreData } from '../../../src/data/store/browser.js';

const baseURL = process.argv[2]!;
const definition = expectOk(
	compileData(
		defineStore({
			id: 'so.epicenter.firstopen',
			tables: {},
			kv: {},
		}),
	),
);
let offline = false;
const account = {
	baseURL,
	authorityId: 'test-authority',
	principalId: asPrincipalId('alice'),
	fetch: (input: RequestInfo | URL, init?: RequestInit) => {
		if (offline) throw new Error('offline');
		return fetch(input, {
			...init,
			headers: { authorization: 'Bearer alice' },
		});
	},
	openWebSocket: async (): Promise<WebSocket> => {
		throw new Error('No live sync in this startup fixture');
	},
};
const options = { kind: 'personal' as const, account };

const first = expectOk(
	await acquireStoreData(definition, options, {
		factory: indexedDB,
		keyRange: IDBKeyRange,
	}),
);
const generation = first.replication!.address.generation;
const baseline = Array.from(first.loaded.updates[0]!);
await first.dispose?.();
offline = true;
const reopened = expectOk(
	await acquireStoreData(definition, options, {
		factory: indexedDB,
		keyRange: IDBKeyRange,
	}),
);
console.log(
	JSON.stringify({
		first: generation,
		offline: reopened.replication!.address.generation,
		baseline,
		caches: await indexedDB.databases(),
	}),
);
await reopened.dispose?.();
