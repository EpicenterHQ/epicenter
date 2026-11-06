/**
 * Sync Moments Tests
 *
 * `syncAtMoments` over an open folder in memory and a memory repository,
 * with fake timers: which moments sync, that one sync runs at a time, and
 * when nothing runs. A second computer is a plain memory store syncing
 * through the same repository.
 *
 * Key behaviors:
 * - It syncs when it starts, and a few seconds after the last save of a burst.
 * - Moments during a sync make one sync after it, and `now()` answers that one.
 * - While shown, every few seconds it syncs only when the repository moved
 *   or the folder holds an unsynced change; hidden, it waits; shown again,
 *   it syncs.
 * - A sync's own writes are not saves; with no remote, or once the folder
 *   closes, nothing runs.
 */
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { defineContract } from '@epicenter/definition/contract';
import { expectOk } from 'wellcrafted/testing';
import { memoryStore } from '../device/memory-store.js';
import { memory, memoryFiles } from '../memory.js';
import { openFolder } from '../open-folder.js';
import { type SyncResult, syncAtMoments, type WindowShown } from './moments.js';
import { memoryRepository, type Repository } from './repository.js';
import { storeManifest, sync } from './sync.js';

const contract = defineContract({
	collections: {
		todos: { path: 'todos/{id}.md', fields: { title: { type: 'string' } } },
	},
});

beforeEach(() => {
	jest.useFakeTimers();
});
afterEach(() => {
	jest.useRealTimers();
});

/** Let what is under way settle: promises, and the real I/O fake timers leave alone. */
async function settle() {
	for (let turn = 0; turn < 200; turn++)
		await new Promise((resolve) => setImmediate(resolve));
}

/** Move the clock `ms` forward a half second at a time, letting what each step starts settle. */
async function wait(ms: number) {
	for (let left = ms; left > 0; left -= 500) {
		jest.advanceTimersByTime(Math.min(500, left));
		await settle();
	}
}

/** An open folder syncing at its moments with a repository, a second computer beside it, and a count of each. */
function setup({
	remote: wrap = (repository) => repository,
	window,
}: {
	remote?: (repository: Repository) => Repository;
	window?: WindowShown;
} = {}) {
	const repository = memoryRepository();
	const remote = wrap(repository);
	const place = memory();
	const folder = openFolder(contract, place);
	const results: SyncResult[] = [];
	const moments = syncAtMoments({
		folder,
		remote,
		window,
		synced: (result) => results.push(result),
	});
	const other = memoryStore();
	const otherManifest = storeManifest(other);
	return {
		folder,
		moments,
		results,
		outside: memoryFiles(place),
		/** The other computer writes `text` at `path` and syncs. */
		async otherWrites(path: string, text: string) {
			await other.outside.write(path, text);
			expectOk(
				await sync({
					local: other,
					remote: repository,
					manifest: otherManifest,
				}),
			);
		},
		/** What the other computer holds at `path` once it syncs. */
		async otherReads(path: string) {
			expectOk(
				await sync({
					local: other,
					remote: repository,
					manifest: otherManifest,
				}),
			);
			return other.outside.read(path);
		},
	};
}

/** A window a test shows and hides. */
function testWindow() {
	let shown = true;
	const listeners = new Set<() => void>();
	return {
		window: {
			shown: () => shown,
			subscribe(changed: () => void) {
				listeners.add(changed);
				return () => listeners.delete(changed);
			},
		} satisfies WindowShown,
		set(next: boolean) {
			shown = next;
			for (const listener of listeners) listener();
		},
	};
}

test('with no remote nothing syncs, and now() answers null', async () => {
	const folder = openFolder(contract, memory());
	const synced: SyncResult[] = [];
	const moments = syncAtMoments({
		folder,
		remote: null,
		synced: (result) => synced.push(result),
	});
	expect(await moments.now()).toBeNull();
	await folder.todos.set({ id: 'a' }, { title: 'A' });
	await wait(60_000);
	expect(synced).toEqual([]);
});

test('it syncs when it starts, and a few seconds after the last save of a burst', async () => {
	const { folder, results, otherReads } = setup();
	await settle();
	expect(results).toHaveLength(1);
	for (const id of ['a', 'b', 'c']) {
		await folder.todos.set({ id }, { title: id });
		await wait(1000);
	}
	expect(results).toHaveLength(1);
	await wait(2000);
	expect(results).toHaveLength(2);
	expect(expectOk(results[1] as SyncResult).pushed).toEqual([
		'todos/a.md',
		'todos/b.md',
		'todos/c.md',
	]);
	expect(await otherReads('todos/c.md')).toContain('title: c');
});

test('moments during a sync make one sync after it, which every now() answers', async () => {
	let release = () => {};
	let holding = false;
	const { folder, moments, results } = setup({
		remote: (repository) => ({
			...repository,
			async writeAll(writes) {
				if (holding)
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				return repository.writeAll(writes);
			},
		}),
	});
	await settle();
	expect(results).toHaveLength(1);

	await folder.todos.set({ id: 'a' }, { title: 'A' });
	holding = true;
	const first = moments.now();
	await settle();
	holding = false;
	// While it is held at its repository write: a save, its moment, and two presses.
	await folder.todos.set({ id: 'b' }, { title: 'B' });
	await wait(3000);
	const [second, third] = [moments.now(), moments.now()];
	release();
	const answers = await Promise.all([first, second, third]);
	await settle();
	expect(results).toHaveLength(3);
	expect(answers[1]).toBe(answers[2]);
	expect(answers[0]).not.toBe(answers[1]);
	expect(expectOk(answers[1] as SyncResult).pushed).toEqual(['todos/b.md']);
});

test("while shown it syncs each few seconds only on a change; a sync's own writes are not saves", async () => {
	let asked = 0;
	const { folder, results, otherWrites, outside } = setup({
		remote: (repository) => ({
			...repository,
			changes(since) {
				asked++;
				return repository.changes(since);
			},
		}),
	});
	await settle();
	expect(results).toHaveLength(1);
	await wait(3000 * 4);
	// Each period asked the repository, and nothing synced.
	expect(results).toHaveLength(1);
	expect(asked).toBeGreaterThanOrEqual(4);

	await otherWrites('todos/x.md', '---\ntitle: "X"\n---\n');
	await wait(3000);
	expect(results).toHaveLength(2);
	expect(expectOk(results[1] as SyncResult).pulled).toEqual(['todos/x.md']);
	expect(folder.todos.get({ id: 'x' })).toMatchObject({ title: 'X' });
	// The pull wrote into the folder: no sync follows it as after a save.
	await wait(3000 * 3);
	expect(results).toHaveLength(2);

	// Another program's file in the folder is a change the next check finds.
	await outside.write('notes.txt', 'by hand');
	await wait(3000);
	expect(results).toHaveLength(3);
	expect(expectOk(results[2] as SyncResult).pushed).toEqual(['notes.txt']);
});

test('hidden, it checks nothing; shown or focused again, it syncs at once', async () => {
	const shown = testWindow();
	const { results, otherWrites } = setup({ window: shown.window });
	await settle();
	expect(results).toHaveLength(1);
	shown.set(false);
	await otherWrites('todos/x.md', '---\ntitle: "X"\n---\n');
	await wait(3000 * 5);
	expect(results).toHaveLength(1);
	shown.set(true);
	await settle();
	expect(results).toHaveLength(2);
	expect(expectOk(results[1] as SyncResult).pulled).toEqual(['todos/x.md']);
	// Focused while shown: another sync, and the checks go on.
	shown.set(true);
	await settle();
	expect(results).toHaveLength(3);
	await otherWrites('todos/y.md', '---\ntitle: "Y"\n---\n');
	await wait(3000);
	expect(results).toHaveLength(4);
});

test('once the folder closes, no moment syncs', async () => {
	const { folder, moments, results } = setup();
	await settle();
	expect(results).toHaveLength(1);
	await folder.todos.set({ id: 'a' }, { title: 'A' });
	folder[Symbol.dispose]();
	await wait(60_000);
	expect(results).toHaveLength(1);
	expect(await moments.now()).toBeNull();
});
