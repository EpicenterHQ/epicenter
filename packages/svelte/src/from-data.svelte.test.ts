/**
 * fromData tests
 *
 * Verifies store identity reuse, live table projections, reactive read tracking,
 * and unchanged write capabilities. Reusing a store must not add subscriptions
 * or repeat the initial table walk.
 */
import { expect, mock, test } from 'bun:test';

type SubscriberControl = {
	activate(): void;
	deactivate(): void;
	/**
	 * How many times a read announced itself to this subscriber.
	 *
	 * Without it the harness cannot see tracking at all: `activate` drives the
	 * subscription directly, so a getter that forgot to call its subscriber
	 * still looks correct. This counts the call the getter is supposed to make.
	 */
	tracked: number;
};

const subscriberControls: SubscriberControl[] = [];

/**
 * `createSubscriber` installs its subscription only from inside a Svelte
 * effect, and these are plain bun tests with no reactive runtime. Substituting
 * it with its activation and teardown lifecycle lets the live-snapshot and
 * dormant-read behavior be exercised without reshaping the adapter around the
 * test.
 */
mock.module('svelte/reactivity', () => ({
	// A plain Map stands in for the reactive one. These are bun tests with no
	// reactive runtime, and what is asserted here is WHICH underlying verbs a
	// read pays for; that a `SvelteMap` wakes per key is Svelte's own suite.
	SvelteMap: Map,
	createSubscriber(start: (update: () => void) => () => void) {
		let stop: (() => void) | undefined;
		const control = {
			activate() {
				stop ??= start(() => {});
			},
			deactivate() {
				stop?.();
				stop = undefined;
			},
			tracked: 0,
		};
		subscriberControls.push(control);
		// These tests read getters imperatively, outside a Svelte effect. The
		// real createSubscriber is also a no-op for those reads; tests activate
		// the simulated effect explicitly through this control. Counting the
		// call is what makes a MISSING one visible.
		return () => {
			control.tracked += 1;
		};
	},
}));

import { fromData } from './from-data.svelte.js';

/**
 * An in-memory stand-in for one store table handle: the same closure-object
 * shape the engine freezes, with counters so a test can see which underlying
 * verbs a read actually paid for.
 */
function createFakeTable<TRow extends { id: string }>(seed: TRow[]) {
	const rows = new Map<string, TRow>(seed.map((row) => [row.id, row]));
	/** Rows that are THERE and that this release cannot read (ADR-0125). */
	const unreadable = new Map<string, { id: string; raw: TRow }>();
	const listeners = new Set<(rowIds: readonly string[]) => void>();
	const calls = { rows: 0, get: 0, subscribe: 0, nonconforming: 0 };
	const announce = (rowId: string) => {
		for (const listener of listeners) listener([rowId]);
	};
	return {
		calls,
		/** The row stays, and stops reading: what a folder push can now cause. */
		breakRow(rowId: string) {
			const row = rows.get(rowId);
			if (row === undefined) return;
			rows.delete(rowId);
			unreadable.set(rowId, { id: rowId, raw: row });
			announce(rowId);
		},
		repairRow(rowId: string) {
			const broken = unreadable.get(rowId);
			if (broken === undefined) return;
			unreadable.delete(rowId);
			rows.set(rowId, broken.raw);
			announce(rowId);
		},
		handle: {
			create(fields: Omit<TRow, 'id'>) {
				const row = { id: `row-${rows.size + 1}`, ...fields } as TRow;
				rows.set(row.id, row);
				announce(row.id);
				return row;
			},
			get(rowId: string) {
				calls.get += 1;
				return rows.get(rowId);
			},
			update(rowId: string, fields: Partial<TRow>) {
				const row = rows.get(rowId);
				if (row === undefined) return { data: null, error: { rowId } };
				rows.set(rowId, { ...row, ...fields });
				announce(rowId);
				return { data: undefined, error: null };
			},
			delete(rowId: string) {
				const removed = rows.delete(rowId);
				if (removed) announce(rowId);
			},
			ids() {
				return [...rows.keys(), ...unreadable.keys()].sort();
			},
			get rows() {
				calls.rows += 1;
				return [...rows.values()];
			},
			get nonconforming() {
				calls.nonconforming += 1;
				return [...unreadable.values()];
			},
			watch() {
				return () => undefined;
			},
			subscribe(listener: (rowIds: readonly string[]) => void) {
				calls.subscribe += 1;
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
	};
}

function createFakeKv<TValues>(initial: TValues) {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		set(next: TValues) {
			value = next;
			for (const listener of listeners) listener();
		},
		handle: {
			get<TKey extends keyof TValues & string>(key: TKey) {
				return value[key];
			},
			nonconforming: [],
			update(fields: Partial<TValues>) {
				value = { ...value, ...fields };
				for (const listener of listeners) listener();
			},
			subscribe(listener: () => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
	};
}

/**
 * A stand-in for the store's persistence capability: the change-deduped
 * status feed, with a counter so a test can see that a read paid for one
 * `get` and not a subscription.
 */
function createFakePersistence(initial: 'saved' | 'pending' | 'blocked') {
	let status = initial;
	const listeners = new Set<() => void>();
	const calls = { get: 0, subscribe: 0 };
	return {
		calls,
		set(next: typeof status) {
			if (next === status) return;
			status = next;
			for (const listener of listeners) listener();
		},
		handle: {
			get() {
				calls.get += 1;
				return status;
			},
			subscribe(listener: () => void) {
				calls.subscribe += 1;
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			flush: async () => undefined,
		},
	};
}

type Note = { id: string; title: string };
type Folder = { id: string; name: string };

function setup() {
	subscriberControls.length = 0;
	const notes = createFakeTable<Note>([{ id: 'n1', title: 'first' }]);
	const folders = createFakeTable<Folder>([]);
	const kv = createFakeKv({ theme: 'dark' });
	const persistence = createFakePersistence('saved');
	const data = {
		tables: { notes: notes.handle, folders: folders.handle },
		kv: kv.handle,
		// Passed through untouched, so the fake just runs it.
		transact: <TResult>(run: () => TResult) => run(),
		watch: () => () => undefined,
		persistence: persistence.handle,
	};
	const reactive = fromData(data);
	// Two subscribers, in declaration order: kv, then persistence. A table
	// creates none — its projection IS its signal.
	const [kvControl, persistenceControl] = subscriberControls;
	if (kvControl === undefined || persistenceControl === undefined)
		throw new Error('expected one subscriber control per tracked read');
	return {
		data,
		notes,
		folders,
		kv,
		persistence,
		reactive,
		kvControl,
		persistenceControl,
	};
}

test('mirrors the declared table names and preserves their row types', () => {
	const { reactive } = setup();
	expect(Object.keys(reactive.tables).sort()).toEqual(['folders', 'notes']);
	// Compile-time: the mapped type keeps each table's own row type.
	const rows: Note[] = reactive.tables.notes.rows;
	expect(rows[0]?.title).toBe('first');
	const folderRows: Folder[] = reactive.tables.folders.rows;
	expect(folderRows).toEqual([]);
});

test('wrapping seeds the projection once and never reads `rows`', () => {
	const { notes, folders } = setup();
	// One `get` per seeded row, and no walk through the handle's own `rows`:
	// the projection is built from ids and point reads, which is the only
	// shape that lets a later commit rebuild one row instead of all of them.
	expect(notes.calls.get).toBe(1);
	expect(notes.calls.rows).toBe(0);
	expect(notes.calls.subscribe).toBe(1);
	expect(folders.calls.get).toBe(0);
});

test('a commit rebuilds the rows it named, and no others', () => {
	const { notes, reactive } = setup();
	const before = notes.calls.get;

	notes.handle.create({ title: 'second' });
	// Exactly one rebuild, for the row the commit named. The row already held
	// is untouched, which is the whole point: work proportional to the change.
	expect(notes.calls.get).toBe(before + 1);
	expect(reactive.tables.notes.rows).toHaveLength(2);

	const settled = notes.calls.get;
	expect(reactive.tables.notes.rows).toHaveLength(2);
	expect(reactive.tables.notes.rows).toHaveLength(2);
	// Reading again costs nothing. Before this, each read rebuilt every row.
	expect(notes.calls.get).toBe(settled);
});

test('a removed row leaves the projection', () => {
	const { notes, reactive } = setup();
	expect(reactive.tables.notes.get('n1')?.title).toBe('first');

	notes.handle.delete('n1');

	expect(reactive.tables.notes.get('n1')).toBeUndefined();
	expect(reactive.tables.notes.rows).toEqual([]);
});

test('an edited row is the edited one, not the one that was seeded', () => {
	const { notes, reactive } = setup();
	notes.handle.update('n1', { title: 'renamed' });
	expect(reactive.tables.notes.get('n1')?.title).toBe('renamed');
	expect(reactive.tables.notes.rows[0]?.title).toBe('renamed');
});

test('write verbs pass through to the underlying handle', () => {
	const { notes, reactive } = setup();
	const table = reactive.tables.notes;
	const created = table.create({ title: 'made' });
	expect(created.title).toBe('made');
	expect(table.update(created.id, { title: 'renamed' }).error).toBeNull();
	expect(notes.handle.get(created.id)?.title).toBe('renamed');
	table.delete(created.id);
	expect(notes.handle.get(created.id)).toBeUndefined();
	// Deleting an absent row is a no-op fact, not an outcome: it reports
	// nothing and leaves the table exactly as it found it.
	table.delete(created.id);
	expect(notes.handle.get(created.id)).toBeUndefined();
});

test('point reads pass through and answer from current data', () => {
	const { reactive } = setup();
	const table = reactive.tables.notes;
	expect(table.get('n1')?.title).toBe('first');
	expect(table.get('absent')).toBeUndefined();
	expect(table.ids()).toEqual(['n1']);
});

test('kv get passes through and reflects writes', () => {
	const { kv, reactive } = setup();
	expect(reactive.kv.get('theme')).toBe('dark');
	kv.set({ theme: 'light' });
	expect(reactive.kv.get('theme')).toBe('light');
	reactive.kv.update({ theme: 'dark' });
	expect(reactive.kv.get('theme')).toBe('dark');
});

test('persistence status reads through, and tracks only once something reads it', () => {
	const { reactive, persistence, persistenceControl } = setup();

	// Wrapping subscribes to nothing and reads nothing. Not the law the tables
	// hold any more: they seed and subscribe at wrap time. One enum is not
	// worth holding, so this one stays read-through.
	expect(persistence.calls.get).toBe(0);
	expect(persistence.calls.subscribe).toBe(0);

	expect(reactive.persistence.get()).toBe('saved');
	expect(persistence.calls.get).toBe(1);

	// A simulated effect reading it attaches the store subscription; the value
	// is read through afterwards rather than served from a snapshot.
	persistenceControl.activate();
	expect(persistence.calls.subscribe).toBe(1);
	persistence.set('blocked');
	expect(reactive.persistence.get()).toBe('blocked');
	expect(persistence.calls.get).toBe(2);

	// The read ANNOUNCED itself both times. This is the assertion that fails if
	// the getter stops calling its subscriber, which is the whole of what this
	// wrapper adds: without it the value is still correct and never re-renders.
	expect(persistenceControl.tracked).toBe(2);
});

test('flush passes through untouched', async () => {
	const { reactive } = setup();
	// Not a read, so the adapter has no business wrapping it: the capability's
	// own function is the one that must be reachable.
	await expect(reactive.persistence.flush()).resolves.toBeUndefined();
});

test('a row that stops reading moves into nonconforming on the commit that broke it', () => {
	const { notes, reactive } = setup();
	const table = reactive.tables.notes;
	expect(table.rows.map((row) => row.id)).toEqual(['n1']);
	expect(table.nonconforming).toEqual([]);

	// What a folder push can now cause: the row is there and this release
	// cannot read it (ADR-0125, ADR-0338). Both halves are on screen, so both
	// halves are held.
	notes.breakRow('n1');
	expect(table.rows).toEqual([]);
	expect(table.get('n1')).toBeUndefined();
	expect(table.nonconforming.map((row) => row.id)).toEqual(['n1']);

	notes.repairRow('n1');
	expect(table.rows.map((row) => row.id)).toEqual(['n1']);
	expect(table.nonconforming).toEqual([]);
});

test('nonconforming is held, so reading it costs nothing and a commit costs one pass', () => {
	const { notes, reactive } = setup();
	const table = reactive.tables.notes;
	// Seeding paid for one. This is the assertion that fails if the getter goes
	// back to forwarding the handle's own, which reads CRDT state and touches
	// no signal: correct on every read, and never re-rendered.
	const seeded = notes.calls.nonconforming;
	for (let read = 0; read < 5; read += 1) void table.nonconforming;
	expect(notes.calls.nonconforming).toBe(seeded);

	// A commit that leaves everything readable pays nothing either: telling
	// "no row here" from "a row this release cannot read" costs a pass, and
	// only the commits that empty a row out of `rows` owe it.
	notes.handle.update('n1', { title: 'renamed' });
	expect(notes.calls.nonconforming).toBe(seeded);

	notes.breakRow('n1');
	expect(notes.calls.nonconforming).toBe(seeded + 1);
});

test('repeated adaptation reuses one projection without reseeding or resubscribing', () => {
	const store = setup();
	const initialReads = store.notes.calls.get;
	const initialSubscribers = subscriberControls.length;

	for (let visit = 0; visit < 20; visit += 1) {
		expect(fromData(store.data)).toBe(store.reactive);
	}

	expect(store.notes.calls.get).toBe(initialReads);
	expect(store.notes.calls.subscribe).toBe(1);
	expect(store.folders.calls.subscribe).toBe(1);
	expect(subscriberControls.length).toBe(initialSubscribers);
});

test('separate stores keep independent projections and updates', () => {
	const local = setup();
	const personal = setup();

	expect(fromData(local.data)).not.toBe(fromData(personal.data));
	local.data.tables.notes.update('n1', { title: 'local edit' });

	expect(fromData(local.data).tables.notes.get('n1')?.title).toBe('local edit');
	expect(fromData(personal.data).tables.notes.get('n1')?.title).toBe('first');
});

test('a reused projection contains edits made between route visits', () => {
	const store = setup();
	store.data.tables.notes.update('n1', { title: 'edited while away' });
	store.data.tables.notes.create({ title: 'new while away' });

	const revisited = fromData(store.data);
	expect(revisited).toBe(store.reactive);
	expect(revisited.tables.notes.rows.map((note) => note.title)).toEqual([
		'edited while away',
		'new while away',
	]);
	store.data.tables.notes.delete('n1');
	expect(revisited.tables.notes.rows.map((note) => note.title)).toEqual([
		'new while away',
	]);
});
