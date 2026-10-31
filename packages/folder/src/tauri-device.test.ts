/**
 * `openDevice` from `@epicenter/folder/tauri`, and a standalone app's two
 * roots (`openAppData`, `openDataFolder`): the typed client over a directory
 * the desktop shell lets the window reach, through the folder plugin's
 * storage commands. The shell here is `createGrantedShell`, a real directory
 * behind the plugin's command names, whose allowed roots stand in for
 * Tauri's file-system scope, so what lands is what a desktop folder holds.
 *
 * Key behaviors:
 * - The default is the bound directory itself; a relative `path` names a
 *   folder inside it, and the client sees only that folder
 * - An absolute `path` opens a root the shell allows; any other is
 *   `NotGranted`, a missing one `Missing` unless `create`. `rootOf` answers
 *   the root as the shell answered it
 * - Versions are sha256, so a stale `over` is a `Conflict` and lands nothing
 * - A storage refusal is `Unavailable`; a page outside Tauri opens nothing
 * - The shell's watcher reaches a collection's listeners, inside `path`
 *   only, and every handle over a root hears it whichever opened last
 * - The data folder is the one `settings.md` names, or
 *   `~/Epicenter/<productName>`, which alone is made when missing
 * - The folder picker answers the folder picked, or null when cancelled
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defineContract } from '@epicenter/definition/contract';
import { unwrap } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	createGrantedShell,
	type GrantedShell,
	grantedDirectory,
} from './granted-shell.test-support.js';

let shell: GrantedShell;
let inTauri = true;
/** The home directory and app name Tauri's APIs answer. */
let home = '/home';
let productName = 'Notes';
/** What the folder picker answers next, and what it was asked. */
let picked: string | null = null;
const pickerAsked: unknown[] = [];

type Channel = { onmessage?: (change: { paths: string[] | null }) => void };

mock.module('@tauri-apps/api/core', () => ({
	Channel: class {},
	isTauri: () => inTauri,
	transformCallback: () => 0,
	invoke: (
		cmd: string,
		body?: Record<string, unknown> | Uint8Array,
		options?: { headers?: Record<string, string> },
	) => {
		if (cmd === 'plugin:dialog|open') {
			pickerAsked.push((body as { options: unknown }).options);
			return Promise.resolve(picked);
		}
		return shell.invoke(cmd, body, options);
	},
}));
mock.module('@tauri-apps/api/path', () => ({
	appDataDir: async () => shell.root,
	homeDir: async () => home,
	join: async (...parts: string[]) => join(...parts),
}));
mock.module('@tauri-apps/api/app', () => ({
	getName: async () => productName,
}));

const {
	chooseFolder,
	openAppData,
	openDataFolder,
	openDevice,
	rememberFolder,
	rootOf,
} = await import('./tauri.js');

const notes = defineContract({
	name: 'notes',
	collections: {
		notes: {
			path: 'notes/{id}.md',
			fields: { title: { type: 'string' } },
			required: ['title'],
		},
	},
});

/** The app's settings contract over its AppData root: `settings.md` with `folder`. */
const notesSettings = defineContract({
	name: 'notes-settings',
	collections: {
		settings: { path: 'settings.md', fields: { folder: { type: 'string' } } },
	},
});

const removed: string[] = [];
beforeEach(async () => {
	shell = createGrantedShell(await grantedDirectory('tauri-device-'));
	inTauri = true;
	picked = null;
	pickerAsked.length = 0;
});

afterEach(async () => {
	await rm(shell.root, { recursive: true, force: true });
	await rm(shell.scratch, { recursive: true, force: true });
	for (const path of removed.splice(0))
		await rm(path, { recursive: true, force: true });
});

/** A directory the shell allows beside the bound one, as the picker would. */
async function allowed(prefix: string) {
	const directory = await grantedDirectory(prefix);
	removed.push(directory);
	return directory;
}

/** The latest channel the shell was handed for `root` (null: the window's own). */
function channel(root: string | null): Channel {
	const found = shell.opened.findLast((open) => open.root === root);
	if (found === undefined) throw new Error(`nothing opened ${root}`);
	return found.onChange as Channel;
}

test('the default is the bound directory: a create lands there in house style', async () => {
	const device = unwrap(await openDevice(notes));
	const created = expectOk(
		await device.notes.create({ id: 'a', title: 'First', body: 'Hello.\n' }),
	);
	expect(await readFile(join(shell.root, 'notes/a.md'), 'utf8')).toBe(
		'---\ntitle: First\n---\nHello.\n',
	);
	expect(expectOk(await device.notes.get({ id: 'a' }))).toEqual(created);
	expect(
		expectOk(await device.notes.list()).items.map((note) => note.id),
	).toEqual(['a']);
});

test('a stale write is a Conflict and lands nothing; a current one lands', async () => {
	const device = unwrap(await openDevice(notes));
	const first = expectOk(await device.notes.create({ id: 'a', title: 'One' }));
	const second = expectOk(
		await device.notes.update(
			{ id: 'a' },
			{ title: 'Two' },
			{ over: first.version },
		),
	);
	const stale = expectErr(
		await device.notes.update(
			{ id: 'a' },
			{ title: 'Three' },
			{ over: first.version },
		),
	);
	expect(stale).toMatchObject({ name: 'Conflict', current: second.version });
	expect(await shell.text('notes/a.md')).toBe('---\ntitle: Two\n---\n');
	expectOk(await device.notes.delete({ id: 'a' }, { over: second.version }));
	expect(await shell.text('notes/a.md')).toBeUndefined();
});

test('another program’s edit is read with its own version', async () => {
	const device = unwrap(await openDevice(notes));
	await shell.write('notes/b.md', '---\ntitle: From git\n---\n');
	const read = expectOk(await device.notes.get({ id: 'b' }));
	expect(read.title).toBe('From git');
	expectOk(
		await device.notes.update(
			{ id: 'b' },
			{ title: 'Edited' },
			{ over: read.version },
		),
	);
	expect(await shell.text('notes/b.md')).toBe('---\ntitle: Edited\n---\n');
});

test('path names a folder inside the bound directory, and the client sees only it', async () => {
	await shell.write('notes/outside.md', '---\ntitle: Outside\n---\n');
	const device = unwrap(await openDevice(notes, { path: 'apps/notes' }));
	expectOk(await device.notes.create({ id: 'a', title: 'Inside' }));
	expect(await shell.text('apps/notes/notes/a.md')).toBe(
		'---\ntitle: Inside\n---\n',
	);
	expect(
		expectOk(await device.notes.list()).items.map((note) => note.id),
	).toEqual(['a']);
});

test('a relative path that leaves the bound directory throws', async () => {
	for (const path of ['../elsewhere', 'a//b', 'a/./b'])
		await expect(openDevice(notes, { path })).rejects.toThrow();
});

test('an absolute path opens a root the shell allows; any other is NotGranted, a missing one Missing', async () => {
	const other = await allowed('tauri-device-other-');
	shell = createGrantedShell(shell.root, { grants: [other, `${other}-new`] });
	removed.push(`${other}-new`);
	const there = unwrap(await openDevice(notes, { path: other }));
	expectOk(await there.notes.create({ id: 'a', title: 'There' }));
	expect(rootOf(there)).toBe(await realpath(other));
	expect(rootOf(unwrap(await openDevice(notes)))).toBeUndefined();
	expect(await readFile(join(other, 'notes/a.md'), 'utf8')).toContain(
		'title: There',
	);
	// The window's own folder, named by its path, is the bound directory.
	expectOk(
		await unwrap(await openDevice(notes, { path: shell.root })).notes.create({
			id: 'b',
			title: 'Here',
		}),
	);
	expect(await shell.text('notes/b.md')).toContain('title: Here');
	expect(
		expectErr(await openDevice(notes, { path: '/Users/me/Notes' })),
	).toMatchObject({ name: 'NotGranted', folder: '/Users/me/Notes' });
	expect(
		expectErr(await openDevice(notes, { path: `${other}-new` })),
	).toMatchObject({ name: 'Missing', folder: `${other}-new` });
	unwrap(await openDevice(notes, { path: `${other}-new`, create: true }));
});

test('a storage refusal is Unavailable, and the next call tries again', async () => {
	const device = unwrap(await openDevice(notes));
	shell.control.refuseNext = 1;
	const refused = expectErr(
		await device.notes.create({ id: 'a', title: 'One' }),
	);
	expect(refused.name).toBe('Unavailable');
	expectOk(await device.notes.create({ id: 'a', title: 'One' }));
});

test('outside Tauri nothing opens and the shell is never asked', async () => {
	inTauri = false;
	expect(expectErr(await openDevice(notes)).name).toBe('StorageUnavailable');
	expect(shell.calls).toEqual([]);
});

test("the shell's watcher reaches a collection's listeners, and a folder inside hears only its own paths", async () => {
	const device = unwrap(await openDevice(notes));
	const inside = unwrap(await openDevice(notes, { path: 'inner' }));
	let heard = 0;
	let heardInside = 0;
	const stop = device.notes.subscribe(() => heard++);
	const stopInside = inside.notes.subscribe(() => heardInside++);
	// The shell sends to the channel opened last; both handles hear it.
	const watcher = channel(null);
	if (watcher.onmessage === undefined) throw new Error('no watcher was opened');
	watcher.onmessage({ paths: ['notes/a.md'] });
	expect([heard, heardInside]).toEqual([1, 0]);
	watcher.onmessage({ paths: ['inner/notes/a.md'] });
	expect([heard, heardInside]).toEqual([1, 1]);
	watcher.onmessage({ paths: ['elsewhere/x.md'] });
	expect([heard, heardInside]).toEqual([1, 1]);
	watcher.onmessage({ paths: null });
	expect([heard, heardInside]).toEqual([2, 2]);
	stop();
	stopInside();
	watcher.onmessage({ paths: ['notes/a.md'] });
	expect([heard, heardInside]).toEqual([2, 2]);
});

test('each root hears only its own watcher', async () => {
	const other = await allowed('tauri-device-other-');
	shell = createGrantedShell(shell.root, { grants: [other] });
	const own = unwrap(await openDevice(notes));
	const there = unwrap(await openDevice(notes, { path: other }));
	let heard = 0;
	let heardThere = 0;
	const stop = own.notes.subscribe(() => heard++);
	const stopThere = there.notes.subscribe(() => heardThere++);
	channel(other).onmessage?.({ paths: ['notes/a.md'] });
	expect([heard, heardThere]).toEqual([0, 1]);
	channel(null).onmessage?.({ paths: null });
	expect([heard, heardThere]).toEqual([1, 1]);
	stop();
	stopThere();
});

test('the data folder is ~/Epicenter/<productName> when settings.md names none, made when missing', async () => {
	home = await allowed('tauri-device-home-');
	const fallback = join(home, 'Epicenter', 'Notes Dev');
	productName = 'Notes Dev';
	shell = createGrantedShell(shell.root, { grants: [fallback] });
	const appData = unwrap(await openAppData(notesSettings));
	const device = unwrap(await openDataFolder(notes, { appData }));
	expectOk(await device.notes.create({ id: 'a', title: 'Default' }));
	expect(await readFile(join(fallback, 'notes/a.md'), 'utf8')).toContain(
		'title: Default',
	);
	expect(shell.opened.at(-1)?.root).toBe(fallback);
	productName = 'Notes';
});

test('a folder settings.md names opens as it is: never made, and NotGranted until picked', async () => {
	home = await allowed('tauri-device-home-');
	const chosen = await allowed('tauri-device-chosen-');
	const gone = join(chosen, 'gone');
	const appData = unwrap(await openAppData(notesSettings));
	expectOk(await rememberFolder(appData, chosen));
	// Written by hand or an agent: the shell's scope does not allow it.
	expect(expectErr(await openDataFolder(notes, { appData }))).toMatchObject({
		name: 'NotGranted',
		folder: chosen,
	});
	// "Allow access": the picker at that path; picking it allows it.
	picked = chosen;
	expect(
		unwrap(await chooseFolder({ title: 'Allow access', at: chosen })),
	).toBe(chosen);
	expect(pickerAsked.at(-1)).toMatchObject({
		directory: true,
		recursive: true,
		defaultPath: chosen,
	});
	shell = createGrantedShell(shell.root, { grants: [chosen, gone] });
	unwrap(await openDataFolder(notes, { appData }));
	// A chosen folder that is gone is Missing, never made again.
	expectOk(await rememberFolder(appData, gone));
	expect(expectErr(await openDataFolder(notes, { appData }))).toMatchObject({
		name: 'Missing',
		folder: gone,
	});
	expect(await readFile(join(shell.root, 'settings.md'), 'utf8')).toContain(
		`folder: ${JSON.stringify(gone)}`,
	);
});

test('a cancelled picker answers null', async () => {
	picked = null;
	expect(unwrap(await chooseFolder({ title: 'Choose folder' }))).toBeNull();
});
