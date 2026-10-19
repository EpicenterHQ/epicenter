/**
 * The native `Folder` over a directory the desktop shell registered:
 * `openTauriFolder`. The shell's commands are the stand-ins in
 * `granted-shell.test-support.ts`, which reach the disk through `node:fs`
 * and fail as the shell does.
 *
 * Key behaviors:
 * - The shell grants the registered ID; opening reads existing files and writes none
 * - Every refused grant is an `OpenFolderError` and opens nothing
 * - The automatic opener needs a directory here, and browser storage is refused
 * - A save is one guarded put; a put another writer overtook reads and merges again
 * - A lost reply is the save landing only when the path holds what was sent
 * - The shell's watcher reaches listeners as `other-handle`; history moving does not
 */
import { beforeEach, expect, mock, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { FolderChange } from '../folder.js';
import {
	createGrantedShell,
	type GrantedShell,
	grantedDirectory,
} from '../granted-shell.test-support.js';

let shell: GrantedShell;

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	invoke: (
		cmd: string,
		body?: Record<string, unknown> | Uint8Array,
		options?: { headers?: Record<string, string> },
	) => shell.invoke(cmd, body, options),
}));

const changeHandlers = new Set<(event: { payload: unknown }) => void>();

/** The shell's watcher announcing a change, as the folder plugin emits it. */
function emitChanged(payload: { scope: string; paths: string[] | null }) {
	for (const handler of [...changeHandlers]) handler({ payload });
}

mock.module('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({
		async listen(
			_event: string,
			handler: (event: { payload: unknown }) => void,
		) {
			changeHandlers.add(handler);
			return () => {
				changeHandlers.delete(handler);
			};
		},
	}),
}));

const { openTauriFolder } = await import('./tauri.js');

const notes = Type.Object({ title: Type.String() });
const SCOPE = 'data:Groceries';

beforeEach(() => {
	shell = createGrantedShell('');
	changeHandlers.clear();
});

async function granted(files: Record<string, string> = {}) {
	const root = await grantedDirectory('native-tauri-');
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), content);
	}
	shell = createGrantedShell(root);
	const folder = expectOk(
		await openTauriFolder({ directory: SCOPE, tables: { notes } }),
	);
	return { root, folder };
}

test('the shell grants the registered ID, and opening writes nothing', async () => {
	const { folder } = await granted({
		'notes/milk.md': '---\ntitle: Milk\nfrom: phone\n---\n',
	});
	expect(shell.calls[0]).toEqual({
		cmd: 'grant_directory',
		args: { scope: SCOPE },
	});
	const row = expectOk(await folder.tables.notes.get('milk'))!;
	expect(row.fields).toEqual({ title: 'Milk', from: 'phone' });
	expect(shell.changes).toEqual([]);
	await folder.close();
});

test('every refused grant is a refusal, and nothing opens', async () => {
	shell.control.grant = () => {
		throw { name: 'UnknownScope', scope: SCOPE };
	};
	expect(
		expectErr(await openTauriFolder({ directory: SCOPE, tables: {} })).name,
	).toBe('UnknownScope');
	shell.control.grant = () => {
		throw 'plugin:epicenter-folder|grant_directory not allowed';
	};
	expect(
		expectErr(await openTauriFolder({ directory: SCOPE, tables: {} })).name,
	).toBe('Unavailable');
	expect(
		expectErr(await openTauriFolder({ directory: ' ', tables: {} })).name,
	).toBe('InvalidId');
	expect(
		expectErr(
			await openTauriFolder({ directory: SCOPE, tables: { '.git': notes } }),
		).name,
	).toBe('InvalidTable');
	expect(changeHandlers.size).toBe(0);
});

test('in the desktop app the automatic opener needs a directory, and browser storage is refused', async () => {
	const { openFolder } = await import('../index.js');
	expect(expectErr(await openFolder({ tables: { notes } })).name).toBe(
		'DirectoryRequired',
	);
	const { openFolder: openBrowserFolder } = await import('../browser.js');
	expect(expectErr(await openBrowserFolder({ tables: { notes } })).name).toBe(
		'InsideTauri',
	);
	shell = createGrantedShell(await grantedDirectory('native-tauri-'));
	const folder = expectOk(
		await openFolder({ directory: SCOPE, tables: { notes } }),
	);
	expect(shell.calls[0]).toEqual({
		cmd: 'grant_directory',
		args: { scope: SCOPE },
	});
	await folder.close();
});

test('a save is one guarded put, and an overtaken put reads and merges again', async () => {
	const initial = 'One\n\nMiddle\n\nLast\n';
	const { folder } = await granted({ 'note.md': initial });
	let overtaken = false;
	shell.control.beforeChange = async (change) => {
		if (overtaken || change.path !== 'note.md') return;
		overtaken = true;
		await shell.write('note.md', initial.replace('Last', 'Phone'));
	};
	expectOk(
		await folder.files.write(
			'note.md',
			initial,
			initial.replace('One', 'Laptop'),
		),
	);
	expect(await shell.text('note.md')).toBe('Laptop\n\nMiddle\n\nPhone\n');
	const puts = shell.calls.filter((call) => call.cmd === 'put_folder_file');
	expect(puts).toHaveLength(2);
	expect(puts.every((call) => typeof call.args['if-match'] === 'string')).toBe(
		true,
	);
	await folder.close();
});

test('a lost reply is the save landing only when the path holds what was sent', async () => {
	const { folder } = await granted();
	shell.control.loseReplies = 1;
	expectOk(await folder.files.write('a.md', null, 'a'));
	expect(folder.status.storageFailure).toBeNull();

	// Another program replaces the file before the page reads it back.
	shell.control.afterChange = (change) => {
		if (change.path !== 'b.md') return;
		shell.control.afterChange = undefined;
		writeFileSync(join(shell.root, 'b.md'), 'someone else');
		throw new Error('the reply never reached the window');
	};
	const lost = expectErr(await folder.files.write('b.md', null, 'b'));
	expect(lost).toMatchObject({
		name: 'StorageFailed',
		cause: { name: 'Unconfirmed', path: 'b.md' },
	});
	expect(folder.status.storageFailure).toBe(lost as never);
	expect(await shell.text('b.md')).toBe('someone else');
	await folder.close();
});

test('the shell watcher reaches listeners as other-handle changes until close', async () => {
	const { folder } = await granted();
	const heard: FolderChange[] = [];
	folder.onChange((change) => heard.push(change));
	emitChanged({ scope: SCOPE, paths: ['notes/milk.md'] });
	emitChanged({ scope: SCOPE, paths: ['.git'] });
	emitChanged({ scope: 'data:Other', paths: ['x.md'] });
	emitChanged({ scope: SCOPE, paths: null });
	expect(heard).toEqual([
		{ paths: ['notes/milk.md'], origin: 'other-handle' },
		{ paths: null, origin: 'other-handle' },
	]);
	expectOk(await folder.files.write('a.md', null, 'a'));
	expect(heard.at(-1)).toEqual({ paths: ['a.md'], origin: 'this-handle' });
	await folder.close();
	expect(changeHandlers.size).toBe(0);
});
