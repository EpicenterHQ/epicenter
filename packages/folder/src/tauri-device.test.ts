/**
 * The desktop's `home` (`home.tauri.ts`), the data folder the shell names
 * `Data`, and a root opened by name (`openRoot`): the store over a root the
 * desktop shell named, through the folder plugin's storage commands, and the
 * folder over it. The shell here is `createNamedShell`, real directories
 * behind the plugin's command names, so what lands is what a desktop folder
 * holds.
 *
 * Key behaviors:
 * - A page opens a root by name and holds no path but the one it shows:
 *   every storage call names the root, and the folder's `displayPath()` is
 *   the path `open_root` answered
 * - A data folder behind a link whose
 *   target is gone is `Disconnected`, with words a person reads, and Retry
 *   opens it once it is back; a storage call on it is `Unavailable` with
 *   that `Disconnected` as its cause, and a write waits until it is back
 * - Versions are sha256, so a write over a version the file no longer holds
 *   is `'stale'` and lands nothing; the folder reads again and applies its
 *   change over what another program wrote
 * - A storage refusal is `Unavailable`; a page outside Tauri opens nothing
 * - The shell's watcher reaches a collection's listeners, each root its own
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type Contract, defineContract } from '@epicenter/definition/contract';
import { Ok, unwrap } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { Store } from './device/store.js';
import {
	createNamedShell,
	type NamedShell,
	namedDirectory,
} from './named-shell.test-support.js';

let shell: NamedShell;
let inTauri = true;
/** The AppData root this test's shell named. */
let appData: string;

type FolderEvent = { root: 'Data' | 'AppData'; paths: string[] | null };
const eventListeners = new Set<(event: { payload: FolderEvent }) => void>();
function emit(payload: FolderEvent) {
	for (const listener of eventListeners) listener({ payload });
}
mock.module('@tauri-apps/api/event', () => ({
	listen: async (
		_event: string,
		listener: (event: { payload: FolderEvent }) => void,
	) => {
		eventListeners.add(listener);
		return () => {
			eventListeners.delete(listener);
		};
	},
}));

mock.module('@tauri-apps/api/core', () => ({
	Channel: class {},
	isTauri: () => inTauri,
	transformCallback: () => 0,
	invoke: (
		cmd: string,
		body?: Record<string, unknown> | Uint8Array,
		options?: { headers?: Record<string, string> },
	) => {
		if (cmd.endsWith('|open_root'))
			expect(eventListeners.size).toBeGreaterThan(0);
		return shell.invoke(cmd, body, options);
	},
}));

const { revealRoot } = await import('./tauri.js');
const { home } = await import('./home.tauri.js');
const { openRoot } = await import('./native/root.js');
const { openFolder } = await import('./open-folder.js');
const { openingOf } = await import('./place.js');
const { createFolder } = await import('./folder.js');

/** The store the desktop's `home` opens for a folder of `contract`, or why it did not open. */
function openDataStore(contract: Contract, site: string) {
	return openingOf(home({ site }), contract).open();
}

/** The store over the root the shell named `root`, or why it did not open. */
async function openDevice({ root }: { root: 'Data' | 'AppData' }) {
	const opened = await openRoot(root);
	if (opened.error !== null) return opened;
	return Ok(opened.data.store);
}

/** The folder of `contract` over a store already open. */
function folderOver<TContract extends Contract>(
	contract: TContract,
	store: Store,
) {
	return createFolder(contract, async () => Ok(store));
}

/** What `store` hears, from now until the returned stop. */
async function hearing(store: Store) {
	const heard: (readonly string[] | 'all')[] = [];
	const stop = expectOk(await store.watch((paths) => heard.push(paths)));
	return { heard, stop };
}

/** The version at `path` in `store`, which must hold a file. */
async function versionIn(store: Store, path: string) {
	const [file] = expectOk(await store.read([path]));
	if (file === undefined || 'gone' in file) throw new Error(`nothing at ${path}`);
	return file.version;
}

const bytes = (text: string) => new TextEncoder().encode(text);

const notes = defineContract({
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
	eventListeners.clear();
});

afterEach(async () => {
	await rm(shell.root, { recursive: true, force: true });
	await rm(appData, { recursive: true, force: true });
});

test('a malformed AGENTS.md is left as it is and never stops the folder opening', async () => {
	const malformed = 'My notes.\n<!-- BEGIN epicenter -->\nhalf a block\n';
	await shell.write('AGENTS.md', malformed);
	expectOk(await openDataStore(notes, 'https://notes.example.com'));
	expect(await shell.text('AGENTS.md')).toBe(malformed);
});

test('the data folder opens by name, and a write lands there in house style', async () => {
	const store = unwrap(await openDataStore(notes, 'https://notes.example.com'));
	const agents = await shell.text('AGENTS.md');
	expect(agents).toContain(
		'contract: "https://notes.example.com/contract.json"',
	);
	expect(agents).toContain('notes: `notes/{id}.md`');
	unwrap(await openDataStore(notes, 'https://notes.example.com'));
	expect(await shell.text('AGENTS.md')).toBe(agents);
	expect(
		shell.calls.filter(
			({ cmd, args }) => cmd === 'put_folder_file' && args.path === 'AGENTS.md',
		),
	).toHaveLength(1);
	const folder = folderOver(notes, store);
	await folder.notes.set({ id: 'a' }, { title: 'First', body: 'Hello.\n' });
	expect(await readFile(join(shell.root, 'notes/a.md'), 'utf8')).toBe(
		'---\ntitle: First\n---\nHello.\n',
	);
	const written = { id: 'a', title: 'First', body: 'Hello.\n' };
	expect(folder.notes.get({ id: 'a' })).toEqual(written);
	expect(expectOk(await folder.notes.list()).items).toEqual([written]);
	folder[Symbol.dispose]();
});

test('the page names roots, never paths, and shows the path the shell answered', async () => {
	const folder = openFolder(notes, home({ site: 'https://notes.example.com' }));
	expect(folder.displayPath()).toBeNull();
	await folder.notes.set({ id: 'a' }, { title: 'Here' });
	expect(folder.displayPath()).toBe(shell.root);
	// The path comes from the open command.
	expect(shell.calls[0]?.cmd).toBe('open_root');
	expect(shell.calls.every(({ args }) => args.root === 'Data')).toBe(true);
	folder[Symbol.dispose]();
});

test('AppData opens a settings contract beside the data folder', async () => {
	const settings = folderOver(
		notesSettings,
		unwrap(await openDevice({ root: 'AppData' })),
	);
	const folder = folderOver(
		notes,
		unwrap(await openDataStore(notes, 'https://notes.example.com')),
	);
	await settings.settings.set({}, { theme: 'dark' });
	await folder.notes.set({ id: 'a' }, { title: 'Data' });
	expect(await readFile(join(appData, 'settings.md'), 'utf8')).toContain(
		'theme: dark',
	);
	expect(await shell.text('settings.md')).toBeUndefined();
	settings[Symbol.dispose]();
	folder[Symbol.dispose]();
});

test('a data folder on a drive that is not connected is Disconnected, and Retry opens it once it is back', async () => {
	const folder = '/Users/me/Epicenter/notes';
	const target = '/Volumes/Archive/notes';
	shell.control.refuse = () => ({ name: 'Disconnected', folder, target });
	const refused = expectErr(
		await openDataStore(notes, 'https://notes.example.com'),
	);
	expect(refused).toMatchObject({ name: 'Disconnected', folder, target });
	expect(refused.message).toBe(
		`${folder} is a link to ${target}, a place that isn't available, such as a disconnected drive.`,
	);
	shell.control.refuse = () => undefined;
	unwrap(await openDataStore(notes, 'https://notes.example.com'));
});

test('a storage call on a data folder whose drive went away is Unavailable, with Disconnected as its cause, and a write waits until it is back', async () => {
	const store = unwrap(await openDataStore(notes, 'https://notes.example.com'));
	const folder = folderOver(notes, store);
	const disconnected = {
		name: 'Disconnected',
		folder: shell.root,
		target: '/Volumes/Archive/notes',
	} as const;
	shell.control.refuse = () => disconnected;
	const unavailable = { name: 'Unavailable', cause: disconnected };
	const write = folder.notes.set({ id: 'a' }, { title: 'Kept' });
	await until(() => folder.unavailable() !== null);
	expect(folder.unavailable()).toMatchObject(unavailable);
	expect(folder.saving()).toBe(true);
	expect(await shell.text('notes/a.md')).toBeUndefined();
	shell.control.refuse = () => undefined;
	await write;
	expect(await shell.text('notes/a.md')).toBe('---\ntitle: Kept\n---\n');
	expect(folder.unavailable()).toBeNull();
	expect(folder.saving()).toBe(false);
	shell.control.refuse = () => disconnected;
	expect(expectErr(await store.read(['notes/a.md']))).toMatchObject(
		unavailable,
	);
	folder[Symbol.dispose]();
});

test('each refusal reads as the error a person is shown', async () => {
	shell.control.refuse = () => ({
		name: 'Refused',
		folder: '/Users/me/Epicenter/notes',
		reason:
			"/Users/me is your home folder or holds it, so it cannot be an app's folder.",
	});
	expect(
		expectErr(await openDataStore(notes, 'https://notes.example.com')),
	).toMatchObject({
		name: 'Refused',
		message:
			"/Users/me is your home folder or holds it, so it cannot be an app's folder.",
	});
	shell.control.refuse = () => ({
		name: 'Unavailable',
		folder: '/Users/me/Epicenter/notes',
		message: 'permission denied',
	});
	expect(
		expectErr(await openDataStore(notes, 'https://notes.example.com')),
	).toMatchObject({
		name: 'Unreadable',
		folder: '/Users/me/Epicenter/notes',
	});
	shell.control.refuse = () => undefined;
	shell = createNamedShell({ Data: shell.root });
	expect(expectErr(await openDevice({ root: 'AppData' }))).toMatchObject({
		name: 'StorageUnavailable',
	});
});

test("a write over a version the note no longer holds is 'stale' and lands nothing; a current one lands", async () => {
	const store = unwrap(await openDataStore(notes, 'https://notes.example.com'));
	const path = 'notes/a.md';
	const first = expectOk(
		await store.write(path, bytes('---\ntitle: One\n---\n'), 'absent'),
	);
	if (first === null || first === 'stale') throw new Error('expected a note');
	const second = expectOk(
		await store.write(path, bytes('---\ntitle: Two\n---\n'), first),
	);
	if (second === null || second === 'stale') throw new Error('expected a note');
	expect(
		expectOk(await store.write(path, bytes('---\ntitle: Three\n---\n'), first)),
	).toBe('stale');
	expect(await shell.text(path)).toBe('---\ntitle: Two\n---\n');
	expect(await versionIn(store, path)).toBe(second);
	expect(expectOk(await store.write(path, null, first))).toBe('stale');
	expect(expectOk(await store.write(path, null, second))).toBeNull();
	expect(await shell.text(path)).toBeUndefined();
});

test('a create lands only where nothing is, and a version is checked as one', async () => {
	const store = unwrap(await openDataStore(notes, 'https://notes.example.com'));
	expect(expectOk(await store.write('a.bin', bytes('two'), 'absent'))).toEqual(
		expect.any(String),
	);
	expect(expectOk(await store.write('a.bin', bytes('other'), 'absent'))).toBe(
		'stale',
	);
	expect(await shell.text('a.bin')).toBe('two');
	const [read] = expectOk(await store.read(['a.bin']));
	if (read === undefined || 'gone' in read) throw new Error('a.bin is there');
	expect(
		expectOk(await store.write('a.bin', bytes('three'), read.version)),
	).toEqual(expect.any(String));
	expect(
		expectOk(await store.write('a.bin', bytes('four'), read.version)),
	).toBe('stale');
	expect(await shell.text('a.bin')).toBe('three');
});

test('another program’s edit is read again, and a write applies its change over it', async () => {
	const folder = folderOver(
		notes,
		unwrap(await openDataStore(notes, 'https://notes.example.com')),
	);
	await until(() => folder.state().status === 'open');
	await shell.write('notes/b.md', '---\ntitle: From git\n---\n');
	emit({ root: 'Data', paths: ['notes/b.md'] });
	await until(() => folder.notes.items().length === 1);
	expect(folder.notes.items()).toEqual([
		{ id: 'b', title: 'From git', body: '' },
	]);
	// Another program edits the note after the folder showed it.
	await shell.write(
		'notes/b.md',
		'---\ntitle: From git\n---\nA line from git.\n',
	);
	await folder.notes.set({ id: 'b' }, { title: 'Edited' });
	expect(await shell.text('notes/b.md')).toBe(
		'---\ntitle: Edited\n---\nA line from git.\n',
	);
	expect(folder.notes.get({ id: 'b' })).toEqual({
		id: 'b',
		title: 'Edited',
		body: 'A line from git.\n',
	});
	folder[Symbol.dispose]();
});

test('a storage refusal is Unavailable, and the next call tries again', async () => {
	const store = unwrap(await openDataStore(notes, 'https://notes.example.com'));
	const note = bytes('---\ntitle: One\n---\n');
	shell.control.refuseNext = 1;
	expect(
		expectErr(await store.write('notes/a.md', note, 'absent')).name,
	).toBe('Unavailable');
	expect(await shell.text('notes/a.md')).toBeUndefined();
	expectOk(await store.write('notes/a.md', note, 'absent'));
	expect(await shell.text('notes/a.md')).toBe('---\ntitle: One\n---\n');
});

test('outside Tauri nothing opens and the shell is never asked', async () => {
	inTauri = false;
	expect(expectErr(await openDevice({ root: 'Data' })).name).toBe(
		'StorageUnavailable',
	);
	expect(shell.calls).toEqual([]);
});

test("the shell's watcher reaches a store's watch, until it stops", async () => {
	const store = unwrap(await openDataStore(notes, 'https://notes.example.com'));
	const { heard, stop } = await hearing(store);
	emit({ root: 'Data', paths: ['notes/a.md'] });
	emit({ root: 'Data', paths: null });
	expect(heard).toEqual([['notes/a.md'], 'all']);
	stop();
	emit({ root: 'Data', paths: ['notes/a.md'] });
	expect(heard).toHaveLength(2);
});

test('each root hears only its own watcher', async () => {
	const own = await hearing(
		unwrap(await openDataStore(notes, 'https://notes.example.com')),
	);
	const settings = await hearing(unwrap(await openDevice({ root: 'AppData' })));
	emit({ root: 'AppData', paths: ['settings.md'] });
	expect([own.heard, settings.heard]).toEqual([[], [['settings.md']]]);
	emit({ root: 'Data', paths: null });
	expect([own.heard, settings.heard]).toEqual([['all'], [['settings.md']]]);
	own.stop();
	settings.stop();
});

test('two concurrent opens both hear a later root change', async () => {
	const [first, second] = await Promise.all([
		openDataStore(notes, 'https://notes.example.com'),
		openDataStore(notes, 'https://notes.example.com'),
	]);
	const one = await hearing(unwrap(first));
	const two = await hearing(unwrap(second));
	emit({ root: 'Data', paths: ['notes/a.md'] });
	expect([one.heard, two.heard]).toEqual([[['notes/a.md']], [['notes/a.md']]]);
	one.stop();
	two.stop();
});

test("a folder's collection hears a change the shell's watcher names", async () => {
	const folder = folderOver(
		notes,
		unwrap(await openDataStore(notes, 'https://notes.example.com')),
	);
	await until(() => folder.state().status === 'open');
	await shell.write('notes/a.md', '---\ntitle: Outside\n---\n');
	emit({ root: 'Data', paths: ['notes/a.md'] });
	await until(() => folder.notes.get({ id: 'a' })?.title === 'Outside');
});

test('revealRoot sends only the named root to the shell', async () => {
	shell.calls.length = 0;
	expectOk(await revealRoot('Data'));
	expect(shell.calls).toEqual([{ cmd: 'reveal_root', args: { root: 'Data' } }]);
});

async function until(check: () => boolean) {
	for (let turn = 0; turn < 300 && !check(); turn++) await Bun.sleep(5);
	expect(check()).toBe(true);
}
