/**
 * Local File Tests
 *
 * Every build's `localFile(name)`: memory (`test`), this browser's storage
 * (`default`, over a stand-in `localStorage`), and AppData through the shell
 * (`tauri`, over a stand-in shell).
 *
 * Key behaviors:
 * - A file reads null until written, then its text and a version
 * - A write lands only over the version its writer read; else `stale`
 * - A subscriber hears this window's writes, and the desktop shell's watcher
 * - Another tab's write reaches a browser subscriber as a `storage` event
 */
import { describe, expect, mock, test } from 'bun:test';
import type { LocalFile, OpenLocalFile } from './local-file.js';

/** A stand-in `localStorage` and `window`, enough for the browser leaf. */
const entries = new Map<string, string>();
const windowListeners = new Set<(event: StorageEvent) => void>();
Object.assign(globalThis, {
	localStorage: {
		getItem: (key: string) => entries.get(key) ?? null,
		setItem: (key: string, value: string) => entries.set(key, value),
		removeItem: (key: string) => entries.delete(key),
	},
	window: {
		addEventListener: (_: string, listener: (event: StorageEvent) => void) =>
			windowListeners.add(listener),
		removeEventListener: (_: string, listener: (event: StorageEvent) => void) =>
			windowListeners.delete(listener),
	},
});

/** A stand-in shell: AppData's files, and its watcher's handler. */
const appData = new Map<string, Uint8Array>();
const opened: string[] = [];
let watcher: ((event: { payload: unknown }) => void) | undefined;
mock.module('@tauri-apps/api/core', () => ({
	invoke: async (
		command: string,
		args: Record<string, unknown> | Uint8Array,
		options?: { headers: Record<string, string> },
	) => {
		switch (command) {
			case 'plugin:epicenter-folder|open_root':
				opened.push((args as { root: string }).root);
				return '/Users/me/Library/Application Support/so.epicenter.todos';
			case 'plugin:epicenter-folder|read_folder_file': {
				const { path, root } = args as { path: string; root: string };
				expect(root).toBe('AppData');
				const bytes = appData.get(path);
				if (bytes === undefined) throw { name: 'NotFound' };
				return new Uint8Array([
					...new TextEncoder().encode('stamp'),
					0,
					...bytes,
				]).buffer;
			}
			case 'plugin:epicenter-folder|put_folder_file': {
				const headers = options?.headers ?? {};
				const path = decodeURIComponent(headers.path ?? '');
				const current = appData.get(path);
				const expected = headers.expected ?? '';
				const holds =
					expected === 'absent'
						? current === undefined
						: current !== undefined &&
							`sha256:${await sha256(current)}` === expected;
				if (!holds) return 'stale';
				if (headers.remove === 'true') appData.delete(path);
				else appData.set(path, args as Uint8Array);
				return 'landed';
			}
			default:
				throw new Error(`Unexpected command ${command}`);
		}
	},
}));
mock.module('@tauri-apps/api/event', () => ({
	listen: async (
		_event: string,
		handler: (event: { payload: unknown }) => void,
	) => {
		watcher = handler;
		return () => {
			watcher = undefined;
		};
	},
}));

async function sha256(bytes: Uint8Array) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		bytes as Uint8Array<ArrayBuffer>,
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

const memory = (await import('./memory.js')).localFile;
const browser = (await import('./browser.js')).localFile;
const tauri = (await import('./tauri.js')).localFile;
const leaves: [string, OpenLocalFile][] = [
	['memory', memory],
	['browser', browser],
	['tauri', tauri],
];

async function read(file: LocalFile) {
	const { data, error } = await file.read();
	if (error !== null) throw new Error(error.message);
	return data;
}

/** The version `file` holds now; throws when nothing is there. */
async function versionOf(file: LocalFile) {
	const read = (await file.read()).data;
	if (!read) throw new Error('expected the file to be there');
	return read.version;
}

for (const [build, localFile] of leaves)
	describe(build, () => {
		test('reads null until written, then its text and a version', async () => {
			const file = localFile('models.md');
			expect(await read(file)).toBeNull();
			const written = await file.write('chat: small\n', 'absent');
			expect(await read(file)).toEqual({
				text: 'chat: small\n',
				version: (written.data as { version: string }).version,
			});
		});

		test('a write lands only over the version its writer read', async () => {
			const file = localFile('connections.md');
			await file.write('one', 'absent');
			const first = await versionOf(file);
			expect((await file.write('again', 'absent')).data).toBe('stale');
			expect((await file.write('two', first)).data).toEqual({
				version: expect.any(String),
			});
			expect((await file.write('three', first)).data).toBe('stale');
			expect((await read(file))?.text).toBe('two');
			expect((await file.write(null, await versionOf(file))).data).toEqual({
				version: 'absent',
			});
			expect(await read(file)).toBeNull();
		});

		test('a subscriber hears this window’s writes to its file only', async () => {
			const file = localFile('heard.md');
			let heard = 0;
			const stop = file.subscribe(() => heard++);
			await file.write('one', 'absent');
			await localFile('other.md').write('other', 'absent');
			expect(heard).toBe(1);
			stop();
			await file.write('two', await versionOf(file));
			expect(heard).toBe(1);
		});
	});

test('browser: another tab’s write arrives as a storage event', () => {
	const file = browser('tab.md');
	let heard = 0;
	const stop = file.subscribe(() => heard++);
	for (const listener of windowListeners)
		listener({ key: 'epicenter.local/tab.md' } as StorageEvent);
	for (const listener of windowListeners)
		listener({ key: 'epicenter.local/else.md' } as StorageEvent);
	expect(heard).toBe(1);
	stop();
	expect(windowListeners.size).toBe(0);
});

test('tauri: the file is at the top of AppData, and the watcher’s changes reach a subscriber', async () => {
	const file = tauri('watched.md');
	let heard = 0;
	file.subscribe(() => heard++);
	await Bun.sleep(0);
	expect(opened).toContain('AppData');
	await file.write('by hand', 'absent');
	expect(new TextDecoder().decode(appData.get('watched.md'))).toBe('by hand');
	expect(heard).toBe(1);
	watcher?.({ payload: { root: 'AppData', paths: ['watched.md'] } });
	watcher?.({ payload: { root: 'Data', paths: ['watched.md'] } });
	watcher?.({ payload: { root: 'AppData', paths: ['else.md'] } });
	expect(heard).toBe(2);
});
