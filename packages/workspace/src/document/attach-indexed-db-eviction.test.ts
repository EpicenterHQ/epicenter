/**
 * Regression guard for the closed-IndexedDB write crash.
 *
 * When ANOTHER connection deletes a database a live doc still holds open (a
 * second tab's `wipe()`, any cross-context `clearDocument`), `lib0` fires
 * `versionchange` and closes our connection. Upstream `IndexeddbPersistence`
 * left its `update` listener subscribed and `this.db` pointing at the closed
 * database, so the next Yjs write threw "Can't start a transaction on a closed
 * database" straight into the caller (chat send, model write). `attachIndexedDb`
 * now takes over the `versionchange` handler: it tears the connection down
 * cleanly (unsubscribing that listener) and hands off to `onEvicted` to re-boot.
 */
import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { clearDocument } from 'y-indexeddb';
import * as Y from 'yjs';
import { attachIndexedDb } from './attach-indexed-db.js';
import { attachRecords } from './attach-records.js';
import { defineTable } from './define-table.js';
import { defineWorkspace } from './workspace.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

class FakeBroadcastChannel {
	onmessage: ((event: MessageEvent) => void) | null = null;
	constructor(readonly name: string) {}
	postMessage(_message: unknown): void {}
	close(): void {}
}
Object.assign(globalThis, {
	BroadcastChannel: FakeBroadcastChannel as unknown as typeof BroadcastChannel,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test('external deletion evicts the gateway cleanly instead of crashing later writes', async () => {
	const name = `evict-${crypto.randomUUID()}`;
	const doc = new Y.Doc({ guid: name });
	let evicted = 0;
	const idb = attachIndexedDb(doc, {
		databaseName: name,
		onEvicted: () => {
			evicted += 1;
		},
	});
	await idb.whenLoaded;
	doc.getMap('m').set('a', 1);
	await tick();

	// A second connection (a second tab) deletes this database.
	await clearDocument(name);
	await tick();

	expect(evicted).toBe(1);
	// The still-live doc keeps rendering; its writes must be clean no-ops now,
	// not synchronous crashes into the caller.
	expect(() => doc.getMap('m').set('b', 2)).not.toThrow();
	await idb.whenDisposed;

	doc.destroy();
});

test('our own clearLocal() deletes the store without counting as a foreign eviction', async () => {
	// The sign-in migration calls `source.clearLocal()` while its throwaway
	// source doc is still open; that self-delete must not trigger a page reload.
	const name = `self-clear-${crypto.randomUUID()}`;
	const doc = new Y.Doc({ guid: name });
	let evicted = 0;
	const idb = attachIndexedDb(doc, {
		databaseName: name,
		onEvicted: () => {
			evicted += 1;
		},
	});
	await idb.whenLoaded;
	doc.getMap('m').set('a', 1);
	await tick();

	await idb.clearLocal();
	await tick();

	expect(evicted).toBe(0);
	expect(() => doc.getMap('m').set('b', 2)).not.toThrow();

	doc.destroy();
});

test('our own ydoc.destroy() does not count as an eviction', async () => {
	const name = `self-${crypto.randomUUID()}`;
	const doc = new Y.Doc({ guid: name });
	let evicted = 0;
	const idb = attachIndexedDb(doc, {
		databaseName: name,
		onEvicted: () => {
			evicted += 1;
		},
	});
	await idb.whenLoaded;

	doc.destroy();
	await idb.whenDisposed;
	await tick();

	expect(evicted).toBe(0);
});

const model = defineWorkspace({
	id: `eviction-repro-${crypto.randomUUID()}`,
	name: 'Eviction Repro',
	tables: {
		conversations: defineTable({
			id: field.string(),
			model: field.string(),
		}).docs({
			messages: (ydoc: Y.Doc) =>
				attachRecords<{ id: string; content: string }>(ydoc),
		}),
	},
	kv: {},
});

test('a live workspace survives its databases being deleted by another connection', async () => {
	const workspace = model.connect({ kind: 'local' });
	await workspace.storage.whenLoaded;

	workspace.tables.conversations.set({ id: 'c1', model: 'hosted' });
	const messages = workspace.tables.conversations.docs.messages.open('c1');
	await messages.whenLoaded;
	messages.set('m0', { id: 'm0', content: 'hi' });
	await tick();

	// Another tab of the same install forgets the device: every database this
	// workspace holds open is deleted out from under it.
	await Promise.all([
		clearDocument(workspace.ydoc.guid),
		clearDocument(messages.ydoc.guid),
	]);
	await tick();

	// The reported symptom: model write (root doc) and message write (child doc)
	// must not throw the closed-database error into the caller.
	expect(() => {
		workspace.tables.conversations.update('c1', { model: 'ollama:qwen3' });
	}).not.toThrow();
	expect(() => {
		messages.set('m1', { id: 'm1', content: 'sent' });
	}).not.toThrow();

	messages[Symbol.dispose]();
	workspace[Symbol.dispose]();
});
