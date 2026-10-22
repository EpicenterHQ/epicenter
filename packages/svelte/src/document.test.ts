/**
 * Svelte Document Adapter Tests
 *
 * Drives `reactiveDocument` over real folder documents on an in-memory
 * IndexedDB, reading its getters in effects as components do. The editor
 * handed to the adapter is wrapped to count its subscriptions and reads.
 *
 * Key behaviors:
 * - Adapters are passive until tracked and share their Folder-owned document
 * - Tracking subscribes before the snapshot is read, and the subscription's
 *   synchronous first notification causes no extra run
 * - Every effect over one adapter shares one folder subscription, released
 *   once no effect reads it; the folder keeps the text
 * - Each accepted change re-runs readers once; commands go to the folder
 *
 * See also:
 * - `packages/folder/src/document.test.ts` for the document's own rules
 */
import './svelte-modules.test-support.js';
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import type { FileDocument } from '@epicenter/folder/document';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';

const { reactiveDocument } = await import('./document.js');
const { follow } = await import('./reactive.test-support.svelte.js');
const { flushSync, tick } = await import('svelte');

const notes = Type.Object({ title: Type.String() });
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

async function until(check: () => boolean) {
	for (let turn = 0; turn < 200 && !check(); turn++) {
		await Bun.sleep(5);
		flushSync();
	}
	expect(check()).toBe(true);
}

/** A folder holding `milk`, and its editor wrapped to record what the adapter calls. */
async function setup() {
	globalThis.indexedDB = new IDBFactory();
	const folder = expectOk(
		await openFolder({ tables: { notes }, saveAfterMs: 60_000 }),
	);
	cleanup.push(() => folder.close());
	// A raw write leaves no editor behind, so the editor below starts cold.
	expectOk(
		await folder.files.write(
			'notes/milk.md',
			'---\ntitle: Milk\n---\nTwo litres\n',
		),
	);
	const edit = folder.tables.notes.document('milk');
	const calls: string[] = [];
	const counted: FileDocument<typeof notes> = {
		...edit,
		getSnapshot() {
			calls.push('getSnapshot');
			return edit.getSnapshot();
		},
		subscribe(listener) {
			calls.push('subscribe');
			const stop = edit.subscribe(listener);
			return () => {
				calls.push('unsubscribe');
				stop();
			};
		},
	};
	return { folder, edit, counted, calls };
}

test('constructing adapters and reading untracked getters subscribes to nothing', async () => {
	const { counted, calls } = await setup();
	const adapter = reactiveDocument(counted);
	const another = reactiveDocument(counted);
	expect(calls).toEqual([]);
	// A read outside any effect answers the current snapshot and subscribes to nothing.
	expect(adapter.content).toBeUndefined();
	expect(calls).toEqual(['getSnapshot']);
	expect(another.content).toBeUndefined();
	expect(calls).toEqual(['getSnapshot', 'getSnapshot']);
	expect(adapter.path).toBe('notes/milk.md');
});

test('tracking subscribes before reading, starts the first read, and skips the startup notification', async () => {
	const { counted, calls } = await setup();
	const adapter = reactiveDocument(counted);
	const titles = follow(() => adapter.content?.fields?.title);
	cleanup.push(titles.stop);
	flushSync();
	expect(calls.slice(0, 2)).toEqual(['subscribe', 'getSnapshot']);
	expect(titles.values).toEqual([undefined]);
	await until(() => titles.values.at(-1) === 'Milk');
	expect(titles.values).toEqual([undefined, 'Milk']);
	expect(calls.filter((call) => call === 'subscribe')).toHaveLength(1);
});

test('effects share one subscription across repeated adaptation, released after the last reader leaves', async () => {
	const { counted, calls, edit } = await setup();
	const adapter = reactiveDocument(counted);
	const content = follow(() => adapter.content?.text);
	const dirty = follow(() => adapter.isDirty);
	const another = reactiveDocument(counted);
	const again = follow(() => another.content?.body);
	flushSync();
	await until(() => content.values.at(-1) !== undefined);
	expect(calls.filter((call) => call === 'subscribe')).toHaveLength(1);
	expectOk(adapter.patch({ body: 'Three litres\n' }));
	flushSync();
	expect(again.values.at(-1)).toBe('Three litres\n');
	// One subscription serves every getter, so each reader re-runs per snapshot.
	expect(dirty.values.at(-1)).toBe(true);
	expect(dirty.values.slice(0, -1).every((value) => value === false)).toBe(
		true,
	);
	content.stop();
	dirty.stop();
	await tick();
	expect(calls.filter((call) => call === 'unsubscribe')).toHaveLength(0);
	// Releasing some readers leaves the shared document observed by the last one.
	expectOk(edit.patch({ body: 'Four litres\n' }));
	flushSync();
	expect(again.values.at(-1)).toBe('Four litres\n');
	again.stop();
	await tick();
	expect(calls.filter((call) => call === 'unsubscribe')).toHaveLength(1);
	// Unmounted, the input stays with the folder.
	expect(edit.getSnapshot()).toMatchObject({
		isDirty: true,
		content: { body: 'Four litres\n' },
	});
});

test('each accepted change re-runs a reader once, and commands reach the folder', async () => {
	const { counted, folder } = await setup();
	const adapter = reactiveDocument(counted);
	const bodies = follow(() => adapter.content?.body);
	cleanup.push(bodies.stop);
	flushSync();
	await until(() => bodies.values.at(-1) === 'Two litres\n');
	const runs = bodies.values.length;
	expectOk(adapter.replace('---\ntitle: Milk\n---\nOne litre\n'));
	flushSync();
	expect(bodies.values.length).toBe(runs + 1);
	expectOk(adapter.replace('---\ntitle: Milk\n---\nOne litre\n'));
	flushSync();
	expect(bodies.values.length).toBe(runs + 1);
	const saving = follow(() => adapter.isSaving);
	cleanup.push(saving.stop);
	flushSync();
	expectOk(await adapter.save());
	flushSync();
	expect(saving.values).toContain(true);
	expect(saving.values.at(-1)).toBe(false);
	expect(expectOk(await folder.tables.notes.get('milk'))?.body).toBe(
		'One litre\n',
	);
	expect(adapter.discard()).toBeUndefined();
});

test('adapting a document inside a reactive read does not rebuild subscriptions on input', async () => {
	const { counted, calls, edit } = await setup();
	expectOk(await edit.refresh());
	const bodies = follow(() => reactiveDocument(counted).content?.body);
	flushSync();
	for (const body of ['One\n', 'Two\n', 'Three\n', 'Four\n', 'Five\n']) {
		expectOk(edit.patch({ body }));
		flushSync();
		await tick();
		expect(bodies.values.at(-1)).toBe(body);
	}
	expect(calls.filter((call) => call === 'subscribe')).toHaveLength(1);
	expect(calls.filter((call) => call === 'unsubscribe')).toHaveLength(0);
	bodies.stop();
	await tick();
	expect(calls.filter((call) => call === 'unsubscribe')).toHaveLength(1);
});
