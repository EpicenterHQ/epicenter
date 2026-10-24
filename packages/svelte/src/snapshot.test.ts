/**
 * Snapshot Observation Tests
 *
 * Drives `liveSnapshot` over real folder documents on an in-memory
 * IndexedDB, reading its snapshots in effects as components do. The document
 * handed to the view is wrapped to count its subscriptions and reads.
 *
 * Key behaviors:
 * - Views are passive until tracked and share their Folder-owned document
 * - Tracking subscribes before the snapshot is read, and the subscription's
 *   synchronous first notification causes no extra run
 * - Every effect over one view shares one folder subscription, released
 *   once no effect reads it; the folder keeps the text
 * - Each accepted change re-runs readers once; commands stay on the folder
 *
 * See also:
 * - `packages/folder/src/document.test.ts` for the document's own rules
 */
import './svelte-modules.test-support.js';
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import type { TextDocument } from '@epicenter/folder/document';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';

const { liveSnapshot } = await import('./snapshot.js');
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

/** A folder holding `milk`, and its editor wrapped to record what the view calls. */
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
	const counted: TextDocument<typeof notes> = {
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

test('constructing views and reading untracked snapshots subscribes to nothing', async () => {
	const { counted, calls } = await setup();
	const view = liveSnapshot(counted);
	const another = liveSnapshot(counted);
	expect(calls).toEqual([]);
	// A read outside any effect answers the current snapshot and subscribes to nothing.
	expect(view.current.text).toBeUndefined();
	expect(calls).toEqual(['getSnapshot']);
	expect(another.current.text).toBeUndefined();
	expect(calls).toEqual(['getSnapshot', 'getSnapshot']);
});

test('tracking subscribes before reading, starts the first read, and skips the startup notification', async () => {
	const { folder, counted, calls } = await setup();
	const view = liveSnapshot(counted);
	const titles = follow(() => {
		const text = view.current.text;
		return text === undefined ? undefined : folder.tables.notes.parse(text).fields?.title;
	});
	cleanup.push(titles.stop);
	flushSync();
	expect(calls.slice(0, 2)).toEqual(['subscribe', 'getSnapshot']);
	expect(titles.values).toEqual([undefined]);
	await until(() => titles.values.at(-1) === 'Milk');
	expect(titles.values).toEqual([undefined, 'Milk']);
	expect(calls.filter((call) => call === 'subscribe')).toHaveLength(1);
});

test('effects share a view subscription; independent views share the core document', async () => {
	const { folder, counted, calls, edit } = await setup();
	const view = liveSnapshot(counted);
	const content = follow(() => view.current.text);
	const dirty = follow(() => view.current.isDirty);
	const another = liveSnapshot(counted);
	const again = follow(() => {
		const text = another.current.text;
		return text === undefined ? undefined : folder.tables.notes.parse(text).body;
	});
	flushSync();
	await until(() => content.values.at(-1) !== undefined);
	expect(calls.filter((call) => call === 'subscribe')).toHaveLength(2);
	expectOk(edit.patch({ body: 'Three litres\n' }));
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
	expect(calls.filter((call) => call === 'unsubscribe')).toHaveLength(1);
	// Releasing some readers leaves the shared document observed by the last one.
	expectOk(edit.patch({ body: 'Four litres\n' }));
	flushSync();
	expect(again.values.at(-1)).toBe('Four litres\n');
	again.stop();
	await tick();
	expect(calls.filter((call) => call === 'unsubscribe')).toHaveLength(2);
	// Unmounted, the input stays with the folder.
	expect(edit.getSnapshot().isDirty).toBe(true);
	expect(edit.getSnapshot().text).toContain('Four litres\n');
});

test('each accepted change re-runs a reader once, and commands reach the folder', async () => {
	const { counted, folder, edit } = await setup();
	const view = liveSnapshot(counted);
	const bodies = follow(() => {
		const text = view.current.text;
		return text === undefined ? undefined : folder.tables.notes.parse(text).body;
	});
	cleanup.push(bodies.stop);
	flushSync();
	await until(() => bodies.values.at(-1) === 'Two litres\n');
	const runs = bodies.values.length;
	expectOk(edit.replace('---\ntitle: Milk\n---\nOne litre\n'));
	flushSync();
	expect(bodies.values.length).toBe(runs + 1);
	expectOk(edit.replace('---\ntitle: Milk\n---\nOne litre\n'));
	flushSync();
	expect(bodies.values.length).toBe(runs + 1);
	const saving = follow(() => view.current.isSaving);
	cleanup.push(saving.stop);
	flushSync();
	expectOk(await edit.save());
	flushSync();
	expect(saving.values).toContain(true);
	expect(saving.values.at(-1)).toBe(false);
	expect(expectOk(await folder.tables.notes.get('milk'))?.body).toBe(
		'One litre\n',
	);
	expect(edit.discard()).toBeUndefined();
});

test('a stable snapshot view does not rebuild subscriptions on input', async () => {
	const { folder, counted, calls, edit } = await setup();
	expectOk(await edit.refresh());
	const snapshot = liveSnapshot(counted);
	const bodies = follow(() => {
		const text = snapshot.current.text;
		return text === undefined ? undefined : folder.tables.notes.parse(text).body;
	});
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

/** An ordinary external source: no Folder or document API is involved. */
function numberSource(initial: number) {
	let value = initial;
	const listeners = new Set<(value: number) => void>();
	let starts = 0;
	let stops = 0;
	return {
		getSnapshot: () => value,
		subscribe(listener: (value: number) => void) {
			starts++;
			listeners.add(listener);
			listener(value);
			return () => {
				stops++;
				listeners.delete(listener);
			};
		},
		set(next: number) {
			value = next;
			for (const listener of listeners) listener(value);
		},
		get starts() {
			return starts;
		},
		get stops() {
			return stops;
		},
	};
}

test('untracked reads inside effects stay passive and startup runs once on every activation', async () => {
	const { untrack } = await import('svelte');
	const source = numberSource(1);
	const snapshot = liveSnapshot(source);
	const passive = follow(() => untrack(() => snapshot.current));
	cleanup.push(passive.stop);
	flushSync();
	expect(passive.values).toEqual([1]);
	expect(source.starts).toBe(0);
	const first = follow(() => snapshot.current);
	flushSync();
	expect(first.values).toEqual([1]);
	first.stop();
	await tick();
	expect(source.stops).toBe(1);
	source.set(2);
	expect(snapshot.current).toBe(2);
	expect(source.starts).toBe(1);
	const second = follow(() => snapshot.current);
	flushSync();
	expect(second.values).toEqual([2]);
	expect(passive.values).toEqual([1]);
	second.stop();
	await tick();
	expect(source.starts).toBe(2);
	expect(source.stops).toBe(2);
});

test('identity-derived collection views do not re-subscribe on values and release removed members', async () => {
	const { cell, derive } = await import('./reactive.test-support.svelte.js');
	const a = numberSource(1);
	const b = numberSource(10);
	const members = cell([a, b]);
	const views = derive(() =>
		members.value.map((source) => liveSnapshot(source)),
	);
	const reader = follow(() => views.value.map((view) => view.current));
	flushSync();
	expect(reader.values).toEqual([[1, 10]]);
	for (const next of [2, 3, 4]) {
		a.set(next);
		flushSync();
		await tick();
		expect(reader.values.at(-1)).toEqual([next, 10]);
	}
	expect([a.starts, b.starts, a.stops, b.stops]).toEqual([1, 1, 0, 0]);
	members.value = [b];
	flushSync();
	await tick();
	expect(reader.values.at(-1)).toEqual([10]);
	expect(a.stops).toBe(1);
	// Membership replacement may recreate the remaining bridge; both are released.
	reader.stop();
	await tick();
	expect(a.starts).toBe(a.stops);
	expect(b.starts).toBe(b.stops);
});
