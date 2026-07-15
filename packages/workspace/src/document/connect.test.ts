/**
 * `connect()` regression guard for both arms of the boot decision
 * (ADR-0088/ADR-0094): `connect(null)` wires the bare local-first bundle
 * (guid-named IndexedDB, no relay, per-row child-doc openers included) and
 * its `wipe()` clears the whole bare guid family; `connect(connection)`
 * persists under the principal-scoped database name.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { asPrincipalId } from '@epicenter/identity';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import type * as Y from 'yjs';
import { defineTable } from './define-table.js';
import { defineWorkspace } from './workspace.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

const originalBroadcastChannel = globalThis.BroadcastChannel;

class FakeBroadcastChannel {
	static names: string[] = [];
	onmessage: ((event: MessageEvent) => void) | null = null;
	constructor(public name: string) {
		FakeBroadcastChannel.names.push(name);
	}
	postMessage(_message: unknown): void {}
	close(): void {}
}

const model = defineWorkspace({
	id: 'clw-notes',
	name: 'CLW Notes',
	tables: {
		notes: defineTable({
			id: field.string(),
			title: field.string(),
		}).docs({ body: (ydoc: Y.Doc) => ({ text: ydoc.getText('body') }) }),
	},
	kv: {},
});

async function databaseNames(): Promise<(string | undefined)[]> {
	const dbs = await indexedDB.databases();
	return dbs.map((db) => db.name);
}

beforeEach(() => {
	FakeBroadcastChannel.names = [];
	Object.assign(globalThis, {
		BroadcastChannel:
			FakeBroadcastChannel as unknown as typeof BroadcastChannel,
	});
});

afterEach(() => {
	Object.assign(globalThis, { BroadcastChannel: originalBroadcastChannel });
});

test('bare root + bare child docs persist under guid names, no relay', async () => {
	const bundle = model.connect({ kind: 'local' });

	expect(bundle.collaboration).toBeUndefined();
	await bundle.storage.whenLoaded;

	bundle.tables.notes.set({ id: 'n1', title: 'first' });
	const body = bundle.tables.notes.docs.body.open('n1');
	body.text.insert(0, 'hello');
	await body.whenLoaded;

	const names = await databaseNames();
	expect(names).toContain('clw-notes');
	expect(names).toContain(bundle.tables.notes.docs.body.guid('n1'));
	// Cross-tab channels for both the root and the child, keyed by guid.
	expect(FakeBroadcastChannel.names).toContain('yjs.clw-notes');
	expect(FakeBroadcastChannel.names).toContain('yjs.clw-notes.notes.n1.body');

	bundle[Symbol.dispose]();
});

test('signed-in root persists under the principal-scoped database name', async () => {
	const bundle = model.connect({
		kind: 'server',
		baseURL: 'https://api.example.com',
		principalId: asPrincipalId('owner-1'),
		fetch,
		openWebSocket: () => new Promise<never>(() => {}),
		onReconnectSignal: () => () => {},
	});

	await bundle.storage.whenLoaded;

	expect(await databaseNames()).toContain(
		'epicenter/api.example.com/principals/owner-1/clw-notes',
	);

	bundle[Symbol.dispose]();
});

test('wipe() clears the whole bare guid family', async () => {
	const bundle = model.connect({ kind: 'local' });
	await bundle.storage.whenLoaded;
	bundle.tables.notes.set({ id: 'n2', title: 'doomed' });
	const body = bundle.tables.notes.docs.body.open('n2');
	body.text.insert(0, 'gone soon');
	await body.whenLoaded;

	await bundle.wipe();

	const names = await databaseNames();
	expect(names).not.toContain('clw-notes');
	expect(names.filter((n) => n?.startsWith('clw-notes.'))).toHaveLength(0);
});
