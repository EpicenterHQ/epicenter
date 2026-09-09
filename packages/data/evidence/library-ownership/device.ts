/** Independent process: its own IndexedDB factory and Web Locks registry. */
import 'fake-indexeddb/auto';
import { installTestLocks } from '@epicenter/device/test-locks';
import { asPrincipalId } from '@epicenter/principal';
import { expectOk } from 'wellcrafted/testing';
import { defineData } from '../../src/definition/index.js';
import { resolveGeneration } from '../../src/store/browser.js';

installTestLocks();
const baseURL = process.argv[2]!;
const definition = defineData({
	id: 'so.epicenter.firstopen',
	tables: {},
	kv: {},
});
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
	openWebSocket: () => {
		throw new Error('No live sync in this reproduction');
	},
};
const first = expectOk(
	await resolveGeneration(definition, { appId: 'so.epicenter.notes', account }),
);
offline = true;
const reopened = expectOk(
	await resolveGeneration(definition, { appId: 'so.epicenter.notes', account }),
);
console.log(
	JSON.stringify({
		first: first.generation,
		offline: reopened.generation,
		caches: await indexedDB.databases(),
	}),
);
