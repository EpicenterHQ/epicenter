/**
 * Entry Point Tests
 *
 * The package has one automatic opener and two explicit ones, and all three
 * must be the same contract. These tests pin what each entry does when it is
 * merely imported, when it is asked to open where it cannot, and which
 * adapter the automatic entry chooses.
 *
 * Key behaviors:
 * - Importing any entry opens nothing and touches no global
 * - Every entry exports the same names besides its openers
 * - The automatic entry asks whether this is the desktop app when it is
 *   called, not when it is imported, and loads only the adapter it chose
 * - On a server, or anywhere without the origin private file system, opening
 *   is a returned refusal
 * - The browser entry refuses inside the desktop app, even with storage
 *   handed to it; the desktop entry refuses outside it; neither falls back,
 *   for a data folder either
 * - A browser folder has a local author by default and needs an explicit one
 *   to use a remote
 * - Handles that share browser storage hear each other's saves
 *
 * See also:
 * - `folder.test-d.ts` for the same parity at the type level
 * - `evidence/bundles/bundles.test.ts` for what a build emits per entry
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	createTestStorage,
	locationOf,
} from './browser-storage.test-support.js';
import { useWebLocks } from './web-locks.test-support.js';

let inShell = false;
const invoked: string[] = [];
mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => inShell,
	async invoke(cmd: string) {
		invoked.push(cmd);
		// What Tauri answers when the shell never installed the plugin.
		throw 'plugin epicenter-folder not found';
	},
}));

const globalsBefore = new Set(Object.getOwnPropertyNames(globalThis));
const bufferBefore = (globalThis as { Buffer?: unknown }).Buffer;
const root = await import('./index.js');
const browser = await import('./browser.js');
const tauri = await import('./tauri.js');
const bun = await import('./bun.js');
const contract = await import('./contract.js');

const id = 'so.epicenter.entriestest';
const definition = root.defineFolder({
	kv: {},
	tables: {
		notes: root.defineTable({ fields: { title: root.field.string() } }),
	},
});
const author = { name: 'Entries', email: 'entries@example.test' };

afterEach(() => {
	inShell = false;
	invoked.length = 0;
});

test('importing every entry opens nothing and adds no global', () => {
	expect(invoked).toEqual([]);
	expect(
		Object.getOwnPropertyNames(globalThis).filter(
			(name) => !globalsBefore.has(name),
		),
	).toEqual([]);
	expect((globalThis as { Buffer?: unknown }).Buffer).toBe(bufferBefore);
	// This process has no origin private file system, as a server render has none.
	expect(
		(globalThis as { navigator?: { storage?: unknown } }).navigator?.storage,
	).toBeUndefined();
});

test('every entry exports the same contract beside its openers', () => {
	const names = (entry: object) =>
		Object.keys(entry)
			.filter((name) => name !== 'openFolder' && name !== 'openDataFolder')
			.sort();
	const shared = names(contract);
	expect(shared).toContain('defineFolder');
	expect(shared).toContain('FileError');
	expect(names(root)).toEqual(shared);
	expect(names(tauri)).toEqual(shared);
	expect(names(browser)).toEqual(shared);
	// The directory entry adds its own tools to the same contract.
	expect(names(bun)).toEqual(expect.arrayContaining(shared));
	for (const entry of [root, browser, tauri, bun]) {
		expect(typeof entry.openFolder).toBe('function');
		expect(typeof entry.openDataFolder).toBe('function');
		for (const name of shared)
			expect((entry as Record<string, unknown>)[name]).toBe(
				(contract as Record<string, unknown>)[name],
			);
	}
	// One opener per entry: they are different functions with one signature.
	expect(
		new Set([root, browser, tauri, bun].map((e) => e.openFolder)).size,
	).toBe(4);
	expect(
		new Set([root, browser, tauri, bun].map((e) => e.openDataFolder)).size,
	).toBe(4);
});

test('on a server the automatic entry refuses, and so does each explicit entry', async () => {
	for (const entry of [root, browser])
		expect(expectErr(await entry.openFolder({ id, definition }))).toMatchObject(
			{ name: 'NoFileSystem', missing: 'navigator.storage.getDirectory' },
		);
	expect(expectErr(await tauri.openFolder({ id, definition })).name).toBe(
		'NotTauri',
	);
	for (const entry of [root, browser])
		expect(expectErr(await entry.openDataFolder({ id }))).toMatchObject({
			name: 'NoFileSystem',
		});
	expect(expectErr(await tauri.openDataFolder({ id })).name).toBe('NotTauri');
	expect(invoked).toEqual([]);
});

test('every opener refuses a missing folder ID before it acquires anything, even from an untyped caller', async () => {
	const storage = createTestStorage();
	const untyped = {
		definition,
		browser: { author, ...browserStorage(storage) },
	} as never;
	expect(expectErr(await browser.openFolder(untyped)).name).toBe('InvalidId');
	expect(expectErr(await root.openFolder(untyped)).name).toBe('InvalidId');
	expect(storage.opfs.directories()).toEqual([]);

	inShell = true;
	expect(expectErr(await tauri.openFolder(untyped)).name).toBe('InvalidId');
	expect(expectErr(await root.openFolder(untyped)).name).toBe('InvalidId');
	expect(invoked).toEqual([]);
});

test('the automatic entry decides when it is called: the desktop adapter in the shell, and no browser storage when that fails', async () => {
	const storage = createTestStorage();
	const options = {
		id,
		definition,
		browser: { author, ...browserStorage(storage) },
	};

	// The same imported function, first outside the shell, then inside it.
	const inBrowser = expectOk(await root.openFolder(options));
	expect(inBrowser.location).toEqual(locationOf('so.epicenter.entriestest'));
	await inBrowser.close();
	expect(invoked).toEqual([]);
	// Opening wrote nothing.
	expect(storage.opfs.directories()).toEqual([]);

	inShell = true;
	const other = createTestStorage();
	const refused = expectErr(
		await root.openFolder({
			definition,
			id: 'another.folder',
			browser: { author, ...browserStorage(other) },
		}),
	);
	// The shell has no plugin. That is reported; it is not papered over with
	// a browser folder in another place.
	expect(refused.name).toBe('Unavailable');
	expect(refused.message).toContain('plugin epicenter-folder not found');
	// The shell decides which engine opens the folder, so the grant is asked
	// first; a shell without the plugin answers nothing further.
	expect(invoked).toEqual(['plugin:epicenter-folder|grant_directory']);
	expect(other.opfs.directories()).toEqual([]);
});

test('the browser entry refuses inside the desktop app even when handed storage', async () => {
	inShell = true;
	const storage = createTestStorage();
	const refused = expectErr(
		await browser.openFolder({
			id,
			definition,
			browser: { author, ...browserStorage(storage) },
		}),
	);
	expect(refused.name).toBe('InsideTauri');
	expect(
		expectErr(
			await browser.openDataFolder({
				id,
				browser: { author, ...browserStorage(storage) },
			}),
		).name,
	).toBe('InsideTauri');
	expect(storage.opfs.directories()).toEqual([]);
	expect(invoked).toEqual([]);
});

test('a browser folder defaults to a local author and no remote', async () => {
	const environment = createTestStorage();
	expect(
		expectErr(await browser.openFolder({ definition, id: ' ' })).name,
	).toBe('InvalidId');
	expect(environment.opfs.directories()).toEqual([]);

	const folder = expectOk(
		await browser.openFolder({
			id,
			definition,
			browser: browserStorage(environment),
		}),
	);
	// The history settings in effect are observable on the handle.
	expect(folder.git.snapshot).toMatchObject({
		remote: undefined,
		branch: 'main',
	});
	expectOk(await folder.files.create('a.md', 'a'));
	expect(folder.git.snapshot.lastCommit).toBeUndefined();
	expect((await folder.git.commit()).status).toBe('committed');
	const [commit] = expectOk(await folder.git.log(1));
	expect(commit?.author).toMatchObject({
		name: 'Local',
		email: 'local@localhost',
	});
	await folder.close();
});

test('handles sharing browser storage hear each other, when the storage carries a channel', async () => {
	const environment = createTestStorage({ BroadcastChannel });
	const open = async () =>
		expectOk(
			await browser.openFolder({
				id,
				definition,
				browser: {
					author,
					...browserStorage(environment),
				},
			}),
		);
	const first = await open();
	const second = await open();
	// Each handle's first write publishes the declaration; drain those hints.
	expectOk(await first.files.create('first.md', 'x'));
	expectOk(await second.files.create('second.md', 'x'));
	await Bun.sleep(20);
	const heardByFirst: string[] = [];
	const heardBySecond: string[] = [];
	first.onFilesChanged((paths) => heardByFirst.push(...paths));
	second.onFilesChanged((paths) => heardBySecond.push(...paths));

	expectOk(await first.files.create('from-first.md', 'x'));
	for (let waited = 0; waited < 200 && heardBySecond.length === 0; waited++)
		await Bun.sleep(5);
	expect(heardByFirst).toEqual(['from-first.md']);
	expect(heardBySecond).toEqual(['from-first.md']);
	// The second handle reads what the hint asked it to look at.
	expectOk(await second.files.read('from-first.md'));

	// A closed handle hears nothing more and stops relaying.
	await second.close();
	expectOk(await first.files.create('after-close.md', 'x'));
	await Bun.sleep(20);
	expect(heardBySecond).toEqual(['from-first.md']);
	await first.close();
});

// Commits need the shared lock; this runtime has none of its own.
useWebLocks();
