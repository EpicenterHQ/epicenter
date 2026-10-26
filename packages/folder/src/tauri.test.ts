import { afterEach, expect, mock, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';

const callbacks = new Set<(event: { payload: unknown }) => void>();
let open: () => unknown = () => null;
let listenError: unknown;
let stopped = 0;

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	transformCallback: () => 0,
	invoke: async (command: string) => {
		if (command === 'plugin:epicenter-folder|open_folder') return open();
		if (command === 'plugin:epicenter-folder|list_folder')
			return { files: [], directories: [] };
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

afterEach(() => {
	callbacks.clear();
	open = () => null;
	listenError = undefined;
	stopped = 0;
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
