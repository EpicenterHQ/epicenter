/**
 * The desktop observation bridge installs a scoped listener before returning,
 * keeps filesystem echoes external, and releases listeners on close.
 * No global Tauri listener or file-query polling participates in these reads.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { FolderChange } from '../folder.js';

const callbacks = new Set<(event: { payload: unknown }) => void>();
let open: () => unknown = () => null;
let stopped = 0;
let listenError: unknown;

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	transformCallback: () => 0,
	invoke: async (command: string) => {
		if (command === 'plugin:epicenter-folder|open_folder') return open();
		throw new Error(`Unexpected command ${command}`);
	},
}));
mock.module('@tauri-apps/api/webview', () => ({
	getCurrentWebview: () => ({
		listen: async (
			_name: string,
			callback: (event: { payload: unknown }) => void,
		) => {
			if (listenError !== undefined) throw listenError;
			callbacks.add(callback);
			return () => {
				callbacks.delete(callback);
				stopped++;
			};
		},
	}),
}));
const { openTauriFolder } = await import('./tauri.js');

afterEach(() => {
	callbacks.clear();
	open = () => null;
	stopped = 0;
	listenError = undefined;
});

function emit(paths: string[] | null) {
	for (const callback of callbacks) callback({ payload: { paths } });
}

test('native open precedes listening, and the returned handle owns a scoped listener', async () => {
	open = () => {
		expect(callbacks.size).toBe(0);
		return null;
	};
	const folder = expectOk(await openTauriFolder({ tables: {} }));
	expect(callbacks.size).toBe(1);
	const changes: FolderChange[] = [];
	folder.onChange((change) => changes.push(change));
	emit(['notes']);
	expect(changes).toEqual([{ paths: ['notes'], origin: 'other-handle' }]);
	await folder.close();
	expect(stopped).toBe(1);
	emit(['after-close']);
	expect(changes).toHaveLength(1);
});

test('native refusal installs no listener', async () => {
	open = () => Promise.reject({ name: 'NotBound' });
	expect(expectErr(await openTauriFolder({ tables: {} })).name).toBe(
		'NotBound',
	);
	expect(callbacks.size).toBe(0);
	expect(stopped).toBe(0);
});

test('listener setup failure refuses the open instead of returning an unobserved handle', async () => {
	listenError = new Error('listen refused');
	expect(expectErr(await openTauriFolder({ tables: {} })).name).toBe(
		'Unavailable',
	);
	expect(callbacks.size).toBe(0);
});

test('malformed event payloads invalidate all instead of reaching the owner unchecked', async () => {
	const folder = expectOk(await openTauriFolder({ tables: {} }));
	const seen: FolderChange[] = [];
	folder.onChange((change) => seen.push(change));
	for (const payload of [
		null,
		undefined,
		42,
		{},
		{ paths: undefined },
		{ paths: 'notes/a.md' },
		{ paths: [null] },
		{ paths: ['notes', 1] },
	]) {
		for (const callback of callbacks) callback({ payload });
	}
	expect(seen).toEqual(
		Array.from({ length: 8 }, () => ({ paths: null, origin: 'other-handle' })),
	);
	await folder.close();
});

test('unknown and directory hints reach every open handle as observations', async () => {
	const first = expectOk(await openTauriFolder({ tables: {} }));
	const second = expectOk(await openTauriFolder({ tables: {} }));
	const seen: FolderChange[] = [];
	first.onChange((change) => seen.push(change));
	second.onChange((change) => seen.push(change));
	emit(null);
	emit(['notes']);
	expect(seen).toEqual([
		{ paths: null, origin: 'other-handle' },
		{ paths: null, origin: 'other-handle' },
		{ paths: ['notes'], origin: 'other-handle' },
		{ paths: ['notes'], origin: 'other-handle' },
	]);
	await first.close();
	expect(callbacks.size).toBe(1);
	await second.close();
	expect(callbacks.size).toBe(0);
});
