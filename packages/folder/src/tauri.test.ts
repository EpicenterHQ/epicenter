import { afterEach, expect, mock, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';

let open: () => unknown = () => null;
let changeChannel: { onmessage?: (value: { paths: string[] | null }) => void } | undefined;
let putExpectation: string | undefined;
let putStamp: string | null = 'v1:1:2:3:4';

mock.module('@tauri-apps/api/core', () => ({
	Channel: class {
		onmessage?: (value: { paths: string[] | null }) => void;
	},
	isTauri: () => true,
	transformCallback: () => 0,
	invoke: async (
		command: string,
		body?: { onChange?: typeof changeChannel },
		options?: { headers?: Record<string, string> },
	) => {
		if (command === 'plugin:epicenter-folder|open_folder') {
			changeChannel = body?.onChange;
			return open();
		}
		if (command === 'plugin:epicenter-folder|list_folder')
			return {
				files: [{ path: 'note.txt', size: 3, stamp: 'v1:3:1:3:4' }],
				directories: [],
			};
		if (command === 'plugin:epicenter-folder|read_folder_file') {
			const stamp = new TextEncoder().encode('v1:3:1:3:4');
			return Uint8Array.from([...stamp, 0, ...new TextEncoder().encode('old')]).buffer;
		}
		if (command === 'plugin:epicenter-folder|put_folder_file') {
			putExpectation = options?.headers?.expected;
			return { kind: 'landed', stamp: putStamp };
		}
		throw new Error(`Unexpected command ${command}`);
	},
}));

const { openFolder } = await import('./tauri.js');
const { tauriHostFiles } = await import('./tauri-files.js');

afterEach(() => {
	changeChannel = undefined;
	open = () => null;
	putExpectation = undefined;
	putStamp = 'v1:1:2:3:4';
});

test('Tauri list, read and put retain the shell stamps', async () => {
	const files = tauriHostFiles();
	expect(expectOk(await files.list()).files[0]?.stamp).toBe('v1:3:1:3:4');
	const read = expectOk(await files.read('note.txt'));
	expect(new TextDecoder().decode(read.bytes)).toBe('old');
	expect(read.stamp).toBe('v1:3:1:3:4');
	expect(expectOk(await files.change('note.txt', new TextEncoder().encode('new'), 'any'))).toEqual({
		kind: 'landed',
		stamp: 'v1:1:2:3:4',
	});
	putStamp = null;
	expect(expectOk(await files.change('note.txt', null, 'any'))).toEqual({
		kind: 'landed',
		stamp: null,
	});
});

test('a Tauri put sends absent and content expectations to the shell', async () => {
	const files = tauriHostFiles();
	expectOk(await files.change('notes/a.md', new Uint8Array([1]), 'absent'));
	expect(putExpectation).toBe('absent');
	expectOk(await files.change('notes/a.md', null, { sha256: 'exact-hash' }));
	expect(putExpectation).toBe('exact-hash');
});

test('opens with a private folder change channel', async () => {
	open = () => {
		expect(changeChannel?.onmessage).toBeFunction();
		return null;
	};
	const folder = expectOk(await openFolder({ tables: {} }));
	await folder.close();
});

test('a refused open reports the shell refusal', async () => {
	open = () => Promise.reject({ name: 'NotBound' });
	expect(expectErr(await openFolder({ tables: {} })).name).toBe('NotBound');
});
