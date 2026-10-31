import { afterEach, expect, mock, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';

let open: () => unknown = () => '/notes';
let changeChannel:
	| { onmessage?: (value: { paths: string[] | null }) => void }
	| undefined;
let putExpectation: string | undefined;
let putStamp: string | null = 'v1:1:2:3:4';
let openCalls = 0;
let listedStamp = 'v1:3:1:3:4';
let listedText = 'old';

// `@epicenter/folder/tauri` imports these for a standalone app's roots; nothing here calls them.
mock.module('@tauri-apps/api/app', () => ({ getName: async () => 'Notes' }));
mock.module('@tauri-apps/api/path', () => ({
	appDataDir: async () => '/app-data',
	homeDir: async () => '/home',
	join: async (...parts: string[]) => parts.join('/'),
}));
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
			openCalls++;
			changeChannel = body?.onChange;
			return open();
		}
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

const { openFolder } = await import('./tauri.js');
const { tauriHostFiles } = await import('./tauri-files.js');

afterEach(() => {
	changeChannel = undefined;
	open = () => '/notes';
	putExpectation = undefined;
	putStamp = 'v1:1:2:3:4';
	openCalls = 0;
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
		return '/notes';
	};
	const folder = expectOk(await openFolder({ tables: {} }));
	await folder.close();
});

for (const mode of ['concurrent', 'sequential'] as const) {
	// Each open asks the shell again; the shell sends to the channel opened
	// last, which tells every Folder over the root.
	test(`${mode} opens share changes until each Folder closes`, async () => {
		const [first, second] =
			mode === 'concurrent'
				? await Promise.all([
						openFolder({ tables: {} }),
						openFolder({ tables: {} }),
					])
				: [await openFolder({ tables: {} }), await openFolder({ tables: {} })];
		const firstFolder = expectOk(first);
		const secondFolder = expectOk(second);
		expect(openCalls).toBe(2);
		expect(firstFolder.file('note.txt')?.data).toBe('old');
		expect(secondFolder.file('note.txt')?.data).toBe('old');

		listedStamp = 'v1:5:1:3:4';
		listedText = 'newer';
		changeChannel?.onmessage?.({ paths: ['note.txt'] });
		await Promise.all([firstFolder.idle(), secondFolder.idle()]);
		expect(firstFolder.file('note.txt')?.data).toBe('newer');
		expect(secondFolder.file('note.txt')?.data).toBe('newer');

		await firstFolder.close();
		listedStamp = 'v1:6:1:3:4';
		listedText = 'latest';
		changeChannel?.onmessage?.({ paths: ['note.txt'] });
		await secondFolder.idle();
		expect(secondFolder.file('note.txt')?.data).toBe('latest');
		await secondFolder.close();
	});
}

test('a refused open reports the shell refusal', async () => {
	open = () => Promise.reject({ name: 'NotBound' });
	expect(expectErr(await openFolder({ tables: {} })).name).toBe('NotBound');
});
