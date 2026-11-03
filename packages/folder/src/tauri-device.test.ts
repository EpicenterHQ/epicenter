/**
 * `openDevice` from `@epicenter/folder/tauri`, and a standalone app's two
 * roots (`openAppData`, `openDataFolder`): the typed client over a root the
 * desktop shell named, through the folder plugin's storage commands. The
 * shell here is `createNamedShell`, real directories behind the plugin's
 * command names, so what lands is what a desktop folder holds.
 *
 * Key behaviors:
 * - A page opens a root by name and holds no path but the one it shows:
 *   `rootOf` answers the root's name, which every storage call names, and
 *   `displayPath` the path `root_path` answered; opening answers none
 * - The data folder is made when missing; a data folder behind a link whose
 *   target is gone is `Disconnected`, with words a person reads, and Retry
 *   opens it once it is back; a storage call on it is `Unavailable` with
 *   that `Disconnected` as its cause
 * - Versions are sha256, so a stale `over` is a `Conflict` and lands nothing
 * - A storage refusal is `Unavailable`; a page outside Tauri opens nothing
 * - The shell's watcher reaches a collection's listeners, each root its own
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defineContract } from '@epicenter/definition/contract';
import { unwrap } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { Root } from './native/bindings.gen.js';
import {
	createNamedShell,
	type NamedShell,
	namedDirectory,
} from './named-shell.test-support.js';

let shell: NamedShell;
let inTauri = true;
/** The AppData root this test's shell named. */
let appData: string;

type Channel = { onmessage?: (change: { paths: string[] | null }) => void };

mock.module('@tauri-apps/api/core', () => ({
	Channel: class {},
	isTauri: () => inTauri,
	transformCallback: () => 0,
	invoke: (
		cmd: string,
		body?: Record<string, unknown> | Uint8Array,
		options?: { headers?: Record<string, string> },
	) => shell.invoke(cmd, body, options),
}));

const { displayPath, openAppData, openDataFolder, openDevice, rootOf } =
	await import('./tauri.js');
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

/** A machine-local settings contract over the AppData root. */
const notesSettings = defineContract({
	name: 'notes-settings',
	collections: {
		settings: { path: 'settings.md', fields: { theme: { type: 'string' } } },
	},
});

beforeEach(async () => {
	appData = await namedDirectory('tauri-device-app-data-');
	shell = createNamedShell({
		Data: await namedDirectory('tauri-device-'),
		AppData: appData,
	});
	inTauri = true;
});

afterEach(async () => {
	await rm(shell.root, { recursive: true, force: true });
	await rm(appData, { recursive: true, force: true });
});

/** The latest channel the shell was handed for `root`. */
function channel(root: Root): Channel {
	const found = shell.opened.findLast((open) => open.root === root);
	if (found === undefined) throw new Error(`nothing opened ${root}`);
	return found.onChange as Channel;
}

test('the data folder opens by name, and a create lands there in house style', async () => {
	const device = unwrap(await openDataFolder(notes));
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

test('the page names roots, never paths, and shows the path the shell answered', async () => {
	const device = unwrap(await openDataFolder(notes));
	expect(rootOf(device)).toBe('Data');
	expect(displayPath(device)).toBe(shell.root);
	// The path comes from the display-only command; opening answers nothing.
	expect(shell.calls.map(({ cmd }) => cmd)).toEqual(['open_root', 'root_path']);
	expectOk(await device.notes.create({ id: 'a', title: 'Here' }));
	expect(shell.calls.every(({ args }) => args.root === 'Data')).toBe(true);
	expect(() => rootOf({} as typeof device)).toThrow();
});

test('the data folder is made when nothing is at its path', async () => {
	await rm(shell.root, { recursive: true, force: true });
	const device = unwrap(await openDataFolder(notes));
	expectOk(await device.notes.create({ id: 'a', title: 'Made' }));
	expect(await shell.text('notes/a.md')).toContain('title: Made');
});

test('AppData opens an app-owned settings contract beside the data folder', async () => {
	const settings = unwrap(await openAppData(notesSettings));
	const device = unwrap(await openDataFolder(notes));
	expectOk(await settings.settings.create({ theme: 'dark' }));
	expectOk(await device.notes.create({ id: 'a', title: 'Data' }));
	expect(await readFile(join(appData, 'settings.md'), 'utf8')).toContain(
		'theme: dark',
	);
	expect(await shell.text('settings.md')).toBeUndefined();
	expect(rootOf(settings)).toBe('AppData');
});

test('a data folder on a drive that is not connected is Disconnected, and Retry opens it once it is back', async () => {
	const folder = '/Users/me/Epicenter/notes';
	const target = '/Volumes/Archive/notes';
	shell.control.refuse = () => ({ name: 'Disconnected', folder, target });
	const refused = expectErr(await openDataFolder(notes));
	expect(refused).toMatchObject({ name: 'Disconnected', folder, target });
	expect(refused.message).toBe(
		`${folder} is a link to ${target}, a place that isn't available, such as a disconnected drive.`,
	);
	shell.control.refuse = () => undefined;
	unwrap(await openDataFolder(notes));
});

test('a storage call on a data folder whose drive went away is Unavailable, with Disconnected as its cause', async () => {
	const device = unwrap(await openDataFolder(notes));
	const disconnected = {
		name: 'Disconnected',
		folder: shell.root,
		target: '/Volumes/Archive/notes',
	} as const;
	shell.control.refuse = () => disconnected;
	const unavailable = { name: 'Unavailable', cause: disconnected };
	expect(expectErr(await device.notes.list())).toMatchObject(unavailable);
	expect(expectErr(await device.notes.get({ id: 'a' }))).toMatchObject(
		unavailable,
	);
	expect(
		expectErr(await device.notes.create({ id: 'a', title: 'Lost' })),
	).toMatchObject(unavailable);
	expect(await shell.text('notes/a.md')).toBeUndefined();
});

test('each refusal reads as the error a person is shown', async () => {
	shell.control.refuse = () => ({
		name: 'Refused',
		folder: '/Users/me/Epicenter/notes',
		reason:
			"/Users/me is your home folder or holds it, so it cannot be an app's folder.",
	});
	expect(expectErr(await openDataFolder(notes))).toMatchObject({
		name: 'Refused',
		message:
			"/Users/me is your home folder or holds it, so it cannot be an app's folder.",
	});
	shell.control.refuse = () => ({
		name: 'Unavailable',
		folder: '/Users/me/Epicenter/notes',
		message: 'permission denied',
	});
	expect(expectErr(await openDataFolder(notes))).toMatchObject({
		name: 'Unreadable',
		folder: '/Users/me/Epicenter/notes',
	});
	shell.control.refuse = () => undefined;
	shell = createNamedShell({ Data: shell.root });
	expect(expectErr(await openAppData(notesSettings))).toMatchObject({
		name: 'StorageUnavailable',
	});
});

test('a stale write is a Conflict and lands nothing; a current one lands', async () => {
	const device = unwrap(await openDataFolder(notes));
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
	const device = unwrap(await openDataFolder(notes));
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
	const device = unwrap(await openDataFolder(notes));
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

test('a storage refusal is Unavailable, and the next call tries again', async () => {
	const device = unwrap(await openDataFolder(notes));
	shell.control.refuseNext = 1;
	const refused = expectErr(
		await device.notes.create({ id: 'a', title: 'One' }),
	);
	expect(refused.name).toBe('Unavailable');
	expectOk(await device.notes.create({ id: 'a', title: 'One' }));
});

test('outside Tauri nothing opens and the shell is never asked', async () => {
	inTauri = false;
	expect(expectErr(await openDevice(notes, { root: 'Data' })).name).toBe(
		'StorageUnavailable',
	);
	expect(shell.calls).toEqual([]);
});

test("the shell's watcher reaches a collection's listeners", async () => {
	const device = unwrap(await openDataFolder(notes));
	let heard = 0;
	const stop = device.notes.subscribe(() => heard++);
	const watcher = channel('Data');
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
	const own = unwrap(await openDataFolder(notes));
	const settings = unwrap(await openAppData(notesSettings));
	let heard = 0;
	let heardSettings = 0;
	const stop = own.notes.subscribe(() => heard++);
	const stopSettings = settings.settings.subscribe(() => heardSettings++);
	channel('AppData').onmessage?.({ paths: ['settings.md'] });
	expect([heard, heardSettings]).toEqual([0, 1]);
	channel('Data').onmessage?.({ paths: null });
	expect([heard, heardSettings]).toEqual([1, 1]);
	stop();
	stopSettings();
});
