/**
 * Honeycrisp's state: its orders, and the actions over both collections, on
 * a real device client in a temporary directory.
 *
 * Key behaviors:
 * - Notes sort newest first and folders by name
 * - A new note is made in the folder shown, and opens ready to write in, once
 * - Deleting a folder deletes its file alone: its notes keep naming it and
 *   show in All Notes
 * - Search matches a note's title or text
 *
 * Run with `--conditions=browser` (`bun run test`): `fromClient` needs
 * Svelte's client runtime.
 */
import '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDevice } from '@epicenter/folder/node';
import { honeycrisp } from './contract.js';

const { fromClient } = await import('@epicenter/svelte/client');
const { follow } = await import(
	'../../../../packages/svelte/src/reactive.test-support.svelte.js'
);
const { flushSync } = await import('svelte');
const { byName, createHoneycrisp, newestFirst, shownIn } = await import(
	'./honeycrisp.svelte.js'
);

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

/** A device client over a directory holding `files`. */
async function deviceWith(files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-honeycrisp-'));
	folders.push(root);
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), text);
	}
	return { root, client: openDevice(honeycrisp, { path: root }) };
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
	const device = await deviceWith({
		'notes/a.md': note('2026-10-31T00:00:00.000Z'),
		'notes/b.md': note('2026-10-30T00:00:00.000Z'),
		'notes/c.md': note('2026-10-29T00:00:00.000Z'),
		'folders/w.md': folder('Work'),
		'folders/h.md': folder('Home'),
	});
	const client = fromClient(device.client);
	const shown = follow(() => ({
		notes: client.notes.items.toSorted(newestFirst).map(({ id }) => id),
		folders: client.folders.items.toSorted(byName).map(({ name }) => name),
	}));
	await until(() => !client.notes.loading && !client.folders.loading);
	expect(shown.values.at(-1)).toEqual({
		notes: ['a', 'b', 'c'],
		folders: ['Home', 'Work'],
	});
	shown.stop();
});

test('a new note is made in the folder shown, and opens ready to write in, once', async () => {
	const device = await deviceWith({ 'folders/w.md': folder('Work') });
	// As the "On this device" page composes it: the device's own collections.
	const app = createHoneycrisp(fromClient(device.client));
	app.showFolder('w');
	const created = await app.createNote();
	if (created.error !== null) throw created.error;
	expect(created.data.folderId).toBe('w');
	expect(app.selected).toEqual({ collection: 'notes', id: created.data.id });
	// Its editor takes focus when it opens, and only then.
	expect(app.takeNew(created.data.id)).toBe(true);
	expect(app.takeNew(created.data.id)).toBe(false);
	expect(
		await readFile(join(device.root, `notes/${created.data.id}.md`), 'utf8'),
	).toBe(note(created.data.createdAt, 'folderId: w\n'));
});

test('deleting a folder deletes its file alone; its notes keep naming it and show in All Notes', async () => {
	const device = await deviceWith({
		'folders/w.md': folder('Work'),
		'notes/a.md': note('2026-10-31T00:00:00.000Z', 'folderId: w\n'),
	});
	const client = fromClient(device.client);
	const app = createHoneycrisp(client);
	const shown = follow(
		() => [client.notes.items, client.folders.items] as const,
	);
	await until(() => client.folders.items.length === 1);
	app.showFolder('w');
	expect((await app.deleteFolder('w')).error).toBeNull();
	await until(() => client.folders.items.length === 0);
	expect(app.filter.folderId).toBeNull();
	const [kept] = client.notes.items;
	expect(kept?.folderId).toBe('w');
	expect(kept && shownIn(app.filter, kept)).toBe(true);
	expect(await readFile(join(device.root, 'notes/a.md'), 'utf8')).toBe(
		note('2026-10-31T00:00:00.000Z', 'folderId: w\n'),
	);
	shown.stop();
});

test('search matches a note’s title or text, within the folder shown', () => {
	const at = {
		version: '',
		createdAt: '2026-10-31T00:00:00.000Z',
	} as const;
	const groceries = { ...at, id: 'a', title: 'Groceries', body: 'oat milk\n' };
	const plans = { ...at, id: 'b', folderId: 'w', body: 'Ship the port\n' };
	const shown = (filter: { folderId: string | null; query: string }) =>
		[groceries, plans]
			// SAFETY: the version is opaque and never compared here.
			.filter((n) => shownIn(filter, n as never))
			.map((n) => n.id);
	expect(shown({ folderId: null, query: 'MILK' })).toEqual(['a']);
	expect(shown({ folderId: null, query: 'grocer' })).toEqual(['a']);
	expect(shown({ folderId: 'w', query: '' })).toEqual(['b']);
	expect(shown({ folderId: 'w', query: 'milk' })).toEqual([]);
});
