import { afterEach, expect, mock, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';

const callbacks = new Set<(event: { payload: unknown }) => void>();
let open: () => unknown = () => null;
let listenError: Error | undefined;
let stopped = 0;
let putExpectation: string | undefined;

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	transformCallback: () => 0,
	invoke: async (
		command: string,
		_body?: unknown,
		options?: { headers?: Record<string, string> },
	) => {
		if (command === 'plugin:epicenter-folder|open_folder') return open();
		if (command === 'plugin:epicenter-folder|list_folder')
			return { files: [], directories: [] };
		if (command === 'plugin:epicenter-folder|put_folder_file') {
			putExpectation = options?.headers?.expected;
			return 'landed';
		}
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

const { openFolder } = await import('./tauri.js');
const { tauriHostFiles } = await import('./tauri-files.js');

afterEach(() => {
	callbacks.clear();
	open = () => null;
	listenError = undefined;
	stopped = 0;
	putExpectation = undefined;
});

test('a Tauri put sends absent and content expectations to the shell', async () => {
	const files = tauriHostFiles();
	expectOk(await files.change('notes/a.md', new Uint8Array([1]), 'absent'));
	expect(putExpectation).toBe('absent');
	expectOk(await files.change('notes/a.md', null, { sha256: 'exact-hash' }));
	expect(putExpectation).toBe('exact-hash');
});

test('subscribes to folder changes before returning and releases on close', async () => {
	open = () => {
		expect(callbacks.size).toBe(0);
		return null;
	};
	const folder = expectOk(await openFolder({ tables: {} }));
	expect(callbacks.size).toBe(1);
	await folder.close();
	expect(callbacks.size).toBe(0);
	expect(stopped).toBe(1);
});

test('a refused open installs no listener', async () => {
	open = () => Promise.reject({ name: 'NotBound' });
	expect(expectErr(await openFolder({ tables: {} })).name).toBe('NotBound');
	expect(callbacks.size).toBe(0);
});

test('listener registration failure refuses the open', async () => {
	listenError = new Error('listen refused');
	expect(expectErr(await openFolder({ tables: {} })).name).toBe('Unavailable');
	expect(callbacks.size).toBe(0);
});
