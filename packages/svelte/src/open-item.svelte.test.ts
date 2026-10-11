/**
 * Open Item and Admissions Tests
 *
 * Drives the one-open-item slot and the keyed slots over stand-in sessions,
 * and admissions over plain promises.
 *
 * Key behaviors:
 * - Opening the item already shown does nothing
 * - A load that answers after a newer open is released and never shown
 * - A failed save answers `unsaved` with its session; only that session's discard proceeds
 * - Resolving a review closes a file left deleted and reopens one that cannot be shown
 * - `removeOpen` releases first, removes what the last save confirmed, and reopens when refused
 * - Keyed slots open and leave independently; a slot is dropped once it shows
 *   nothing and no command on it runs, and a late load is released even when
 *   its slot is opened again
 * - Conflict commands find the slot holding their session, and act only
 *   while it is open there
 * - A slot moves to a new key only when that key is free
 * - A command counts from its call, before its first await
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { FileCapture, SaveState } from '@epicenter/folder';
import { Err, Ok } from 'wellcrafted/result';
import type { Resolved } from './edit-session.svelte.js';
import type { OpenSession } from './open-item.svelte.js';

const { createOpenItem, createOpenItems } = await import(
	'./open-item.svelte.ts'
);
const { createAdmissions } = await import('./admissions.svelte.ts');

type Failure = { readonly name: string; readonly message: string };

function fakeSession(path: string) {
	let state: SaveState<Failure> = {
		status: 'saved',
		file: { path, sha256: 'a'.repeat(64) },
	};
	let resolved: Resolved = 'shown';
	const session = {
		released: false,
		get path() {
			return path;
		},
		get state() {
			return state;
		},
		fail() {
			state = {
				status: 'error',
				error: { name: 'Io', message: 'disk' },
				file: state.file,
			};
		},
		/** What the next `resolve` finds the file holds. */
		willResolve(next: Resolved) {
			resolved = next;
		},
		settled: async () => state,
		release() {
			session.released = true;
		},
		adopt: async () => false,
		resolve: async () => Ok(resolved),
	};
	return session satisfies OpenSession;
}

type Session = ReturnType<typeof fakeSession>;
type Item = { readonly key: string; readonly session: Session };

function slot() {
	const loads: string[] = [];
	const gates = new Map<string, PromiseWithResolvers<void>>();
	const open = createOpenItem<string, Item, Session>({
		async load(key) {
			loads.push(key);
			await gates.get(key)?.promise;
			return { key, session: fakeSession(key) };
		},
		sessionOf: (item) => item.session,
	});
	return {
		open,
		loads,
		hold(key: string) {
			const gate = Promise.withResolvers<void>();
			gates.set(key, gate);
			return () => {
				gates.delete(key);
				gate.resolve();
			};
		},
	};
}

test('opening the item already shown does nothing', async () => {
	const { open, loads } = slot();
	await open.open('a');
	const first = open.session;
	expect(await open.open('a')).toEqual({ kind: 'done', left: false });
	expect(open.session).toBe(first);
	expect(loads).toEqual(['a']);
});

test('a load that answers after a newer open is released and never shown', async () => {
	const { open, hold } = slot();
	const release = hold('a');
	const late = open.open('a');
	await open.open('b');
	release();
	expect(await late).toEqual({ kind: 'superseded' });
	expect(open.item?.key).toBe('b');
});

test('a failed save answers unsaved with its session, and only its discard proceeds', async () => {
	const { open } = slot();
	await open.open('a');
	const a = open.session!;
	a.fail();
	expect(open.unsaved).toBe(true);
	expect(await open.open('b')).toEqual({ kind: 'unsaved', session: a });
	expect(open.item?.key).toBe('a');
	const other = fakeSession('x');
	expect(await open.open('b', { discard: other })).toEqual({
		kind: 'unsaved',
		session: a,
	});
	expect(await open.open('b', { discard: a })).toEqual({
		kind: 'done',
		left: true,
	});
	expect(a.released).toBe(true);
	expect(open.item?.key).toBe('b');
});

test('resolving a review closes a file left deleted and reopens one that cannot be shown', async () => {
	const { open, loads } = slot();
	await open.open('a');
	const a = open.session!;
	a.willResolve('other');
	expect((await open.resolve(a, {}))?.data).toBe('reopened');
	expect(a.released).toBe(true);
	expect(open.session).not.toBe(a);
	expect(loads).toEqual(['a', 'a']);

	const reopened = open.session!;
	reopened.willResolve('gone');
	expect((await open.resolve(reopened, {}))?.data).toBe('closed');
	expect(open.item).toBeUndefined();
	// A session that is no longer open is not acted on.
	expect(await open.resolve(reopened, {})).toBeUndefined();
});

test('removeOpen releases first, removes what was saved last, and reopens when refused', async () => {
	const { open } = slot();
	await open.open('a');
	const a = open.session!;
	let removed: FileCapture | undefined;
	const refused = await open.removeOpen(a, async (file) => {
		removed = file;
		expect(a.released).toBe(true);
		return Err({ name: 'Conflict', message: 'changed' });
	});
	expect(refused?.error?.name).toBe('Conflict');
	expect(removed?.path).toBe('a');
	const reopened = open.session!;
	expect(reopened).not.toBe(a);

	const done = await open.removeOpen(reopened, async () => Ok(undefined));
	expect(done?.error).toBeNull();
	expect(open.item).toBeUndefined();
});

test('a command counts from its call, before its first await', async () => {
	const admissions = createAdmissions();
	const gate = Promise.withResolvers<void>();
	let started = false;
	const run = admissions.command(async (value: number) => {
		started = true;
		await gate.promise;
		return value * 2;
	});
	const running = run(21);
	expect(started).toBe(true);
	expect(admissions.busy).toBe(true);
	let quiet = false;
	const waiting = admissions.quiet().then(() => {
		quiet = true;
	});
	await Bun.sleep(5);
	expect(quiet).toBe(false);
	gate.resolve();
	expect(await running).toBe(42);
	await waiting;
	expect(admissions.busy).toBe(false);
});

test('an item shown under another key than asked opens again when asked by that key', async () => {
	const loads: string[] = [];
	let repaired = false;
	const open = createOpenItem<string, Item, Session>({
		async load(key) {
			loads.push(key);
			// A row whose text is not valid opens as text until it is repaired.
			const shownAs = key === 'row' && !repaired ? 'text' : key;
			return { key: shownAs, session: fakeSession(key) };
		},
		sessionOf: (item) => item.session,
		keyOf: (item) => item.key,
	});
	await open.open('row');
	expect(open.shown?.key).toBe('text');
	repaired = true;
	expect(await open.open('row')).toEqual({ kind: 'done', left: true });
	expect(open.item?.key).toBe('row');
	expect(loads).toEqual(['row', 'row']);
});

test('the key follows an item renamed in place, so a reload reads the new path', async () => {
	const loads: string[] = [];
	/** Where a rename moved each session's file. */
	const moved = new Map<Session, string>();
	const open = createOpenItem<string, Item, Session>({
		async load(key) {
			loads.push(key);
			return { key, session: fakeSession(key) };
		},
		sessionOf: (item) => item.session,
		keyOf: (item) => moved.get(item.session) ?? item.key,
	});
	await open.open('old');
	moved.set(open.session!, 'new');
	expect(open.shown?.key).toBe('new');
	expect(await open.open('new')).toEqual({ kind: 'done', left: false });
	await open.reload();
	expect(loads).toEqual(['old', 'new']);
});

/** Keyed slots over stand-in sessions; `hold(key)` holds that key's load. */
function slots() {
	const loads: string[] = [];
	const gates = new Map<string, PromiseWithResolvers<void>>();
	const items = createOpenItems<string, string, Item, Session>({
		async load(key) {
			loads.push(key);
			await gates.get(key)?.promise;
			return { key, session: fakeSession(key) };
		},
		sessionOf: (item) => item.session,
	});
	return {
		items,
		loads,
		hold(key: string) {
			const gate = Promise.withResolvers<void>();
			gates.set(key, gate);
			return () => {
				gates.delete(key);
				gate.resolve();
			};
		},
	};
}

test('keyed slots open and leave independently', async () => {
	const { items } = slots();
	await items.slot('left').open('a');
	await items.slot('right').open('b');
	const a = items.slot('left').session!;
	expect(items.keys().sort()).toEqual(['left', 'right']);
	expect(
		items
			.sessions()
			.map((session) => session.path)
			.sort(),
	).toEqual(['a', 'b']);

	// Opening in one slot leaves only that slot's item.
	await items.slot('right').open('c');
	expect(items.slot('left').session).toBe(a);
	expect(a.released).toBe(false);
	expect(items.slot('right').item?.key).toBe('c');

	// A failed save holds its own slot only.
	a.fail();
	expect(items.slot('left').unsaved).toBe(true);
	expect(items.slot('right').unsaved).toBe(false);
	expect(await items.slot('left').leave()).toEqual({
		kind: 'unsaved',
		session: a,
	});
	expect(await items.slot('right').leave()).toEqual({
		kind: 'done',
		left: true,
	});
	expect(items.keys()).toEqual(['left']);
	expect(await items.slot('left').leave({ discard: a })).toEqual({
		kind: 'done',
		left: true,
	});
	expect(items.keys()).toEqual([]);
	expect(items.slot('left').item).toBeUndefined();
});

test('a slot with a load running is kept, and a load left behind is released even when the slot opens again', async () => {
	const { items, hold, loads } = slots();
	const release = hold('a');
	const late = items.slot('pane').open('a');
	expect(items.keys()).toEqual(['pane']);
	await Bun.sleep(0);
	// Loading: forgetting it drops what loads, and the slot stays while it runs.
	expect(items.slot('pane').shown).toEqual({ status: 'loading', key: 'a' });
	items.slot('pane').forget();
	expect(items.keys()).toEqual(['pane']);
	await items.slot('pane').open('b');
	release();
	expect(await late).toEqual({ kind: 'superseded' });
	expect(items.slot('pane').item?.key).toBe('b');
	expect(loads).toEqual(['a', 'b']);

	// Nothing shown and nothing running: the slot is dropped.
	await items.slot('pane').leave();
	expect(items.keys()).toEqual([]);
});

test('resolve finds the slot holding its session, and acts only while it is open there', async () => {
	const { items, loads } = slots();
	await items.slot('left').open('a');
	await items.slot('right').open('b');
	const b = items.slot('right').session!;
	expect(items.holding(b)).toBe('right');
	b.willResolve('other');
	expect((await items.resolve(b, {}))?.data).toBe('reopened');
	expect(b.released).toBe(true);
	expect(loads).toEqual(['a', 'b', 'b']);
	// No longer open anywhere: not acted on.
	expect(items.holding(b)).toBeUndefined();
	expect(await items.resolve(b, {})).toBeUndefined();
	expect(await items.slot('right').resolve(b, {})).toBeUndefined();

	const reopened = items.slot('right').session!;
	reopened.willResolve('gone');
	expect((await items.resolve(reopened, {}))?.data).toBe('closed');
	expect(items.keys()).toEqual(['left']);
	expect((await items.resolve(items.slot('left').session!, {}))?.data).toBe(
		'shown',
	);
});

test('a slot moves to a free key with its item and session, and refuses a taken one', async () => {
	const { items } = slots();
	await items.slot('old').open('a');
	await items.slot('other').open('b');
	const a = items.slot('old').session!;
	expect(items.move('old', 'other')).toBe(false);
	expect(items.move('old', 'new')).toBe(true);
	expect(items.slot('old').session).toBeUndefined();
	expect(items.slot('new').session).toBe(a);
	expect(items.holding(a)).toBe('new');
	expect(items.keys().sort()).toEqual(['new', 'other']);
});

test('closing waits for every slot and names each draft that could not be saved', async () => {
	const { items } = slots();
	await items.slot('left').open('a');
	await items.slot('right').open('b');
	const a = items.slot('left').session!;
	const b = items.slot('right').session!;
	a.fail();
	expect(await items.close()).toEqual(['a']);
	expect(a.released).toBe(true);
	expect(b.released).toBe(true);
});
