/**
 * Honeycrisp's state: its orders, and the actions over both collections, on
 * a folder over a temporary directory (`directory` from
 * `@epicenter/folder/node`), the contract's files at the same paths, in
 * place of the folder the page is given.
 *
 * Key behaviors:
 * - Notes sort newest first and folders by name
 * - A new note is made in the folder shown, and opens ready to write in, once
 * - Deleting a folder deletes its file alone: its notes keep naming it and
 *   show in All Notes
 * - Search matches a note's title or text
 *
 * Run with `--conditions=browser` (`bun run test`): `reactive` needs
 * Svelte's client runtime.
 */
import '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFolder } from '@epicenter/folder';
import { directory } from '@epicenter/folder/node';
import { honeycrisp } from './contract.js';

const { reactive } = await import('@epicenter/svelte/reactive');
const { follow } = await import(
	'../../../../packages/svelte/src/reactive.test-support.svelte.js'
);
const { flushSync } = await import('svelte');
const { byName, createHoneycrisp, newestFirst, shownIn } = await import(
	'./honeycrisp.svelte.js'
);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A directory holding `files`, and the folder over it, as `$lib/app` opens
 * its own, read through `reactive`.
 */
async function folderWith(files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-honeycrisp-'));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), text);
	}
	const opened = openFolder(honeycrisp, directory(root));
	cleanups.push(() => opened[Symbol.dispose]());
	expect((await opened.notes.list()).error).toBeNull();
	return { root, store: reactive(opened) };
}

/** A note in house style: `extra` holds the keys the contract orders before `createdAt`. */
const note = (createdAt: string, extra = '') =>
	`---\n${extra}createdAt: "${createdAt}"\n---\n`;
const folder = (name: string) => `---\nname: ${name}\n---\n`;

/** Wait, flushing Svelte's effects, until `done` holds. */
async function until(done: () => boolean) {
	for (let turn = 0; turn < 400; turn++) {
		flushSync();
		if (done()) return;
		await Bun.sleep(5);
	}
	throw new Error('timed out');
}

test('notes sort newest first and folders by name', async () => {
	const { store } = await folderWith({
		'notes/a.md': note('2026-10-31T00:00:00.000Z'),
		'notes/b.md': note('2026-10-30T00:00:00.000Z'),
		'notes/c.md': note('2026-10-29T00:00:00.000Z'),
		'folders/w.md': folder('Work'),
		'folders/h.md': folder('Home'),
	});
	const shown = follow(() => ({
		notes: store.notes
			.items()
			.toSorted(newestFirst)
			.map(({ id }) => id),
		folders: store.folders
			.items()
			.toSorted(byName)
			.map(({ name }) => name),
	}));
	await until(() => shown.values.at(-1)?.notes.length === 3);
	expect(shown.values.at(-1)).toEqual({
		notes: ['a', 'b', 'c'],
		folders: ['Home', 'Work'],
	});
	shown.stop();
});

test('a new note is made in the folder shown, and opens ready to write in, once', async () => {
	const { root, store } = await folderWith({ 'folders/w.md': folder('Work') });
	// As the page composes it: the folder's own collections.
	const app = createHoneycrisp(store);
	app.showFolder('w');
	const id = await app.createNote();
	const created = store.notes.get({ id });
	expect(created?.folderId).toBe('w');
	expect(app.selected).toEqual({ collection: 'notes', id });
	// Its editor takes focus when it opens, and only then.
	expect(app.takeNew(id)).toBe(true);
	expect(app.takeNew(id)).toBe(false);
	expect(await readFile(join(root, `notes/${id}.md`), 'utf8')).toBe(
		note(created?.createdAt ?? '', 'folderId: w\n'),
	);
});

test('deleting a folder deletes its file alone; its notes keep naming it and show in All Notes', async () => {
	const { root, store } = await folderWith({
		'folders/w.md': folder('Work'),
		'notes/a.md': note('2026-10-31T00:00:00.000Z', 'folderId: w\n'),
	});
	const app = createHoneycrisp(store);
	const shown = follow(
		() => [store.notes.items(), store.folders.items()] as const,
	);
	await until(() => store.folders.items().length === 1);
	app.showFolder('w');
	await app.deleteFolder('w');
	await until(() => store.folders.items().length === 0);
	expect(app.filter.folderId).toBeNull();
	const [kept] = store.notes.items();
	expect(kept?.folderId).toBe('w');
	expect(kept && shownIn(app.filter, kept)).toBe(true);
	expect(await readFile(join(root, 'notes/a.md'), 'utf8')).toBe(
		note('2026-10-31T00:00:00.000Z', 'folderId: w\n'),
	);
	shown.stop();
});

test('search matches a note’s title or text, within the folder shown', () => {
	const at = { createdAt: '2026-10-31T00:00:00.000Z' };
	const groceries = { ...at, id: 'a', title: 'Groceries', body: 'oat milk\n' };
	const plans = { ...at, id: 'b', folderId: 'w', body: 'Ship the port\n' };
	const shown = (filter: { folderId: string | null; query: string }) =>
		[groceries, plans].filter((n) => shownIn(filter, n)).map((n) => n.id);
	expect(shown({ folderId: null, query: 'MILK' })).toEqual(['a']);
	expect(shown({ folderId: null, query: 'grocer' })).toEqual(['a']);
	expect(shown({ folderId: 'w', query: '' })).toEqual(['b']);
	expect(shown({ folderId: 'w', query: 'milk' })).toEqual([]);
});
