/**
 * `openDevice` from `@epicenter/folder/tauri`, and a standalone app's two
 * roots (`openAppData`, `openDataFolder`): the typed client over a directory
 * the desktop shell lets the window reach, through the folder plugin's
 * storage commands. The shell here is `createGrantedShell`, a real directory
 * behind the plugin's command names, whose allowed roots stand in for
 * Tauri's file-system scope, so what lands is what a desktop folder holds.
 *
 * Key behaviors:
 * - `path` is the root's absolute path: the bound directory, or a root the
 *   shell allows; any other is `NotGranted`, a missing one `Missing` unless
 *   `create`. `rootOf` answers the root as the shell answered it, and every
 *   storage call names it
 * - Versions are sha256, so a stale `over` is a `Conflict` and lands nothing
 * - A storage refusal is `Unavailable`; a page outside Tauri opens nothing
 * - The shell's watcher reaches a collection's listeners, and every handle
 *   over a root hears it whichever opened last
 * - The data folder is the one `settings.md` names, or
 *   `~/Epicenter/<productName>`, which alone is made when missing
 * - The folder picker answers the folder picked by its canonical path, or
 *   null when cancelled; picking remembers that path in `settings.md`, or
 *   forgets `folder` when it is the default, however either was spelled
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
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
	openAppData,
	openDataFolder,
	openDevice,
	pickDataFolder,
	rememberFolder,
	rootOf,
} = await import('./tauri.js');
const { chooseFolder } = await import('./desktop-folder.js');
const { storeOf } = await import('./device/client.js');

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
	for (const path of removed.splice(0))
		await rm(path, { recursive: true, force: true });
});

/** A directory the shell allows beside the bound one, as the picker would. */
async function allowed(prefix: string) {
	const directory = await grantedDirectory(prefix);
	removed.push(directory);
	return directory;
}

/** The latest channel the shell was handed for `root`. */
function channel(root: string): Channel {
	const found = shell.opened.findLast((open) => open.root === root);
	if (found === undefined) throw new Error(`nothing opened ${root}`);
	return found.onChange as Channel;
}

test('the default is the bound directory: a create lands there in house style', async () => {
	const device = unwrap(await openDevice(notes, { path: shell.root }));
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
	const device = unwrap(await openDevice(notes, { path: shell.root }));
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

test('a create lands only where nothing is, and a version is checked as one', async () => {
	const device = unwrap(await openDevice(notes, { path: shell.root }));
	const store = storeOf(device);
	const bytes = (text: string) => new TextEncoder().encode(text);
	expect(expectOk(await store.write('a.bin', bytes('two'), 'absent'))).toBe(
		'landed',
	);
	expect(expectOk(await store.write('a.bin', bytes('other'), 'absent'))).toBe(
		'stale',
	);
	expect(await shell.text('a.bin')).toBe('two');
	const read = expectOk(await store.read('a.bin'));
	expect(
		expectOk(
			await store.write('a.bin', bytes('three'), {
				sha256: read!.version,
			}),
		),
	).toBe('landed');
	expect(
		expectOk(
			await store.write('a.bin', bytes('four'), {
				sha256: read!.version,
			}),
		),
	).toBe('stale');
	expect(await shell.text('a.bin')).toBe('three');
});

test('another program’s edit is read with its own version', async () => {
	const device = unwrap(await openDevice(notes, { path: shell.root }));
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

test('a path opens a root the shell allows; any other is NotGranted, a missing one Missing', async () => {
	const other = await allowed('tauri-device-other-');
	shell = createGrantedShell(shell.root, { grants: [other, `${other}-new`] });
	removed.push(`${other}-new`);
	const there = unwrap(await openDevice(notes, { path: other }));
	expectOk(await there.notes.create({ id: 'a', title: 'There' }));
	expect(rootOf(there)).toBe(await realpath(other));
	expect(await readFile(join(other, 'notes/a.md'), 'utf8')).toContain(
		'title: There',
	);
	// The directory the shell bound to the window opens by its path too.
	const here = unwrap(await openDevice(notes, { path: shell.root }));
	expect(rootOf(here)).toBe(shell.root);
	expectOk(await here.notes.create({ id: 'b', title: 'Here' }));
	expect(await shell.text('notes/b.md')).toContain('title: Here');
	// Every storage call names the root it means.
	expect(
		shell.calls
			.filter(({ cmd }) => cmd !== 'open_folder')
			.every(({ args }) => args.root === shell.root || args.root === other),
	).toBe(true);
	// A relative path names no root, and the shell refuses it.
	expect(expectErr(await openDevice(notes, { path: 'notes' }))).toMatchObject({
		name: 'Refused',
		folder: 'notes',
	});
	expect(
		expectErr(await openDevice(notes, { path: '/Users/me/Notes' })),
	).toMatchObject({ name: 'NotGranted', folder: '/Users/me/Notes' });
	expect(
		expectErr(await openDevice(notes, { path: `${other}-new` })),
	).toMatchObject({ name: 'Missing', folder: `${other}-new` });
	unwrap(await openDevice(notes, { path: `${other}-new`, create: true }));
});

test('a storage refusal is Unavailable, and the next call tries again', async () => {
	const device = unwrap(await openDevice(notes, { path: shell.root }));
	shell.control.refuseNext = 1;
	const refused = expectErr(
		await device.notes.create({ id: 'a', title: 'One' }),
	);
	expect(refused.name).toBe('Unavailable');
	expectOk(await device.notes.create({ id: 'a', title: 'One' }));
});

test('outside Tauri nothing opens and the shell is never asked', async () => {
	inTauri = false;
	expect(expectErr(await openDevice(notes, { path: shell.root })).name).toBe(
		'StorageUnavailable',
	);
	expect(shell.calls).toEqual([]);
});

test("the shell's watcher reaches a collection's listeners", async () => {
	const device = unwrap(await openDevice(notes, { path: shell.root }));
	let heard = 0;
	const stop = device.notes.subscribe(() => heard++);
	const watcher = channel(shell.root);
	if (watcher.onmessage === undefined) throw new Error('no watcher was opened');
	watcher.onmessage({ paths: ['notes/a.md'] });
	expect(heard).toBe(1);
	watcher.onmessage({ paths: ['elsewhere/x.md'] });
	expect(heard).toBe(1);
	watcher.onmessage({ paths: null });
	expect(heard).toBe(2);
	stop();
	watcher.onmessage({ paths: ['notes/a.md'] });
	expect(heard).toBe(2);
});

test('each root hears only its own watcher', async () => {
	const other = await allowed('tauri-device-other-');
	shell = createGrantedShell(shell.root, { grants: [other] });
	const own = unwrap(await openDevice(notes, { path: shell.root }));
	const there = unwrap(await openDevice(notes, { path: other }));
	let heard = 0;
	let heardThere = 0;
	const stop = own.notes.subscribe(() => heard++);
	const stopThere = there.notes.subscribe(() => heardThere++);
	channel(other).onmessage?.({ paths: ['notes/a.md'] });
	expect([heard, heardThere]).toEqual([0, 1]);
	channel(shell.root).onmessage?.({ paths: null });
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
	// "Allow access": the picker at that path; picking it allows it, as the
	// dialog plugin allows what it answers.
	shell = createGrantedShell(shell.root, { grants: [chosen, gone] });
	picked = chosen;
	expect(
		unwrap(await chooseFolder({ title: 'Allow access', at: chosen })),
	).toBe(chosen);
	expect(pickerAsked.at(-1)).toMatchObject({
		directory: true,
		recursive: true,
		defaultPath: chosen,
	});
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

test('a folder picked through a link is remembered by its one canonical path', async () => {
	home = await allowed('tauri-device-home-');
	const chosen = await allowed('tauri-device-chosen-');
	const alias = join(await allowed('tauri-device-link-'), 'alias');
	await symlink(chosen, alias);
	const appData = unwrap(await openAppData(notesSettings));
	// The picker allows the path it answered, as the dialog plugin does.
	shell = createGrantedShell(shell.root, { grants: [alias] });
	picked = alias;
	expect(
		unwrap(await pickDataFolder(appData, { title: 'Choose data folder' })),
	).toBe(true);
	expect(unwrap(await appData.settings.get({})).folder).toBe(chosen);
	// "Allow access" at the remembered path answers the same spelling.
	picked = alias;
	expect(
		unwrap(await chooseFolder({ title: 'Allow access', at: chosen })),
	).toBe(chosen);
	// A cancelled pick remembers nothing new.
	picked = null;
	expect(
		unwrap(await pickDataFolder(appData, { title: 'Choose data folder' })),
	).toBe(false);
	expect(unwrap(await appData.settings.get({})).folder).toBe(chosen);
});

test('the default folder is forgotten when picked, however its path is spelled', async () => {
	// Home reached through a link, as a temporary HOME under /tmp is
	// /private/tmp on macOS: the default is named through the link and the
	// picker answers the real path.
	const real = await allowed('tauri-device-real-home-');
	home = join(await allowed('tauri-device-link-'), 'home');
	await symlink(real, home);
	const fallback = join(home, 'Epicenter', 'Notes');
	await mkdir(join(real, 'Epicenter', 'Notes'), { recursive: true });
	const appData = unwrap(await openAppData(notesSettings));
	expectOk(await rememberFolder(appData, '/elsewhere'));
	shell = createGrantedShell(shell.root, {
		grants: [fallback, join(real, 'Epicenter', 'Notes')],
	});
	picked = join(real, 'Epicenter', 'Notes');
	expect(
		unwrap(await pickDataFolder(appData, { title: 'Choose data folder' })),
	).toBe(true);
	expect(unwrap(await appData.settings.get({})).folder).toBeUndefined();
});

test('a picked folder the shell will not open is refused before it is remembered', async () => {
	home = await allowed('tauri-device-home-');
	const appData = unwrap(await openAppData(notesSettings));
	picked = await allowed('tauri-device-ungranted-');
	expect(
		expectErr(await pickDataFolder(appData, { title: 'Choose data folder' })),
	).toMatchObject({ name: 'NotGranted', folder: picked });
	expect(expectErr(await appData.settings.get({}))).toMatchObject({
		name: 'NotFound',
	});
});
