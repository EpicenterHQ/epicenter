import { afterEach, expect, mock, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';

let putExpectation: string | undefined;
let putStamp: string | null = 'v1:1:2:3:4';
let listedStamp = 'v1:3:1:3:4';
let listedText = 'old';

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	transformCallback: () => 0,
	invoke: async (
		command: string,
		_body?: unknown,
		options?: { headers?: Record<string, string> },
	) => {
		if (command === 'plugin:epicenter-folder|list_folder')
			return [{ path: 'note.txt', stamp: listedStamp }];
		if (command === 'plugin:epicenter-folder|read_folder_file') {
			const stamp = new TextEncoder().encode(listedStamp);
			return Uint8Array.from([
				...stamp,
				0,
				...new TextEncoder().encode(listedText),
			]).buffer;
		}
		if (command === 'plugin:epicenter-folder|put_folder_file') {
			putExpectation = options?.headers?.expected;
			return { kind: 'landed', stamp: putStamp };
		}
		throw new Error(`Unexpected command ${command}`);
	},
}));

const { tauriHostFiles } = await import('./tauri-files.js');

afterEach(() => {
	putExpectation = undefined;
	putStamp = 'v1:1:2:3:4';
	listedStamp = 'v1:3:1:3:4';
	listedText = 'old';
});

test('Tauri list, read and put retain the shell stamps', async () => {
	const files = tauriHostFiles();
	expect(expectOk(await files.list())[0]?.stamp).toBe('v1:3:1:3:4');
	const read = expectOk(await files.read('note.txt'));
	expect(new TextDecoder().decode(read.bytes)).toBe('old');
	expect(read.stamp).toBe('v1:3:1:3:4');
	expect(
		expectOk(
			await files.change('note.txt', new TextEncoder().encode('new'), 'any'),
		),
	).toEqual({
		kind: 'landed',
		stamp: 'v1:1:2:3:4',
	});
	putStamp = null;
	expect(expectOk(await files.change('note.txt', null, 'any'))).toEqual({
		kind: 'landed',
		stamp: null,
	});
});

test('a Tauri put sends each expectation in its own spelling: absent, any, or a tagged hash', async () => {
	const files = tauriHostFiles();
	expectOk(await files.change('notes/a.md', new Uint8Array([1]), 'absent'));
	expect(putExpectation).toBe('absent');
	expectOk(await files.change('notes/a.md', null, { sha256: 'exact-hash' }));
	expect(putExpectation).toBe('sha256:exact-hash');
	expectOk(await files.change('notes/a.md', new Uint8Array([1]), 'any'));
	expect(putExpectation).toBe('any');
});
