/**
 * The native `Folder` over the directory the desktop shell bound to this
 * window: `openTauriFolder`. The shell's commands are the stand-ins in
 * `granted-shell.test-support.ts`, which reach the disk through `node:fs`
 * and fail as the shell does.
 *
 * Key behaviors:
 * - Opening names no folder; it reads existing files and writes none
 * - Every refused open is an `OpenFolderError`, and nothing opens or falls back
 * - No command names a scope, root, or window
 * - A save is one guarded put; a put another writer overtook reads and merges again
 * - A lost reply is the save landing only when the path holds what was sent
 * - Own saves and peer handles report precise paths without a native event listener
 */
import { beforeEach, expect, mock, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
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

const { openTauriFolder } = await import('./tauri.js');

const notes = Type.Object({ title: Type.String() });

beforeEach(() => {
	shell = createGrantedShell('');
});

async function granted(files: Record<string, string> = {}) {
	const root = await grantedDirectory('native-tauri-');
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), content);
	}
	shell = createGrantedShell(root);
	const folder = expectOk(await openTauriFolder({ tables: { notes } }));
	return { root, folder };
}

test('opening names no folder, reads existing files, and writes nothing', async () => {
	const { folder } = await granted({
		'notes/milk.md': '---\ntitle: Milk\nfrom: phone\n---\n',
	});
	expect(shell.calls[0]).toEqual({ cmd: 'open_folder', args: {} });
	const row = expectOk(await folder.tables.notes.get('milk'))!;
	expect(row.fields).toEqual({ title: 'Milk', from: 'phone' });
	expect(shell.changes).toEqual([]);
	expectOk(
		await folder.files.write('notes/eggs.md', null, '---\ntitle: Eggs\n---\n'),
	);
	expectOk(await folder.files.list());
	// No command names the folder: the shell answers in the calling window's.
	for (const call of shell.calls) {
		for (const name of ['scope', 'root', 'window'])
			expect(call.args).not.toHaveProperty(name);
		if (call.cmd === 'read_folder_children')
			expect(
				call.args.directory === '' || call.args.directory === 'notes',
			).toBe(true);
		else expect(call.args).not.toHaveProperty('directory');
	}
	await folder.close();
});

test('every refused open is a refusal, and nothing opens or falls back', async () => {
	const refusals = [
		{ name: 'NotBound' },
		{ name: 'Missing' },
		{ name: 'ShuttingDown' },
		{ name: 'Unavailable', message: 'the disk is gone' },
	] as const;
	for (const refusal of refusals) {
		shell.control.open = () => {
			throw refusal;
		};
		expect(expectErr(await openTauriFolder({ tables: {} })).name).toBe(
			refusal.name,
		);
	}
	// Tauri rejects with text when the window lacks the permission.
	shell.control.open = () => {
		throw 'open_folder not allowed';
	};
	expect(expectErr(await openTauriFolder({ tables: {} })).name).toBe(
		'Unavailable',
	);
	expect(
		expectErr(await openTauriFolder({ tables: { '.git': notes } })).name,
	).toBe('InvalidTable');
	expect(shell.calls.map((call) => call.cmd)).toEqual(
		Array(refusals.length + 1).fill('open_folder'),
	);
});

test('a page that names a directory is refused, and the shell is not asked', async () => {
	const named = { directory: '/Users/a/Notes', tables: { notes } };
	expect(expectErr(await openTauriFolder(named as never)).name).toBe(
		'InvalidRoot',
	);
	expect(shell.calls).toEqual([]);
});

test('the automatic opener opens the window folder, and browser storage is refused', async () => {
	const { openFolder } = await import('../index.js');
	const { openFolder: openBrowserFolder } = await import('../browser.js');
	expect(expectErr(await openBrowserFolder({ tables: { notes } })).name).toBe(
		'InsideTauri',
	);
	shell = createGrantedShell(await grantedDirectory('native-tauri-'));
	const folder = expectOk(await openFolder({ tables: { notes } }));
	expect(shell.calls[0]).toEqual({ cmd: 'open_folder', args: {} });
	await folder.close();
	shell.control.open = () => {
		throw { name: 'NotBound' };
	};
	expect(expectErr(await openFolder({ tables: { notes } })).name).toBe(
		'NotBound',
	);
});

test('the pause a window folder is opened with saves its held input, through either opener', async () => {
	const { openFolder } = await import('../index.js');
	for (const open of [openTauriFolder, openFolder]) {
		const root = await grantedDirectory('native-tauri-');
		await mkdir(join(root, 'notes'));
		await writeFile(join(root, 'notes/milk.md'), '---\ntitle: Milk\n---\n');
		shell = createGrantedShell(root);
		const folder = expectOk(await open({ tables: { notes }, saveAfterMs: 5 }));
		const edit = folder.tables.notes.edit('milk');
		expectOk(await edit.read());
		expectOk(edit.change({ fields: { title: 'Oat' } }));
		expect(folder.getStatus().unsaved).toEqual(['notes/milk.md']);
		for (let turn = 0; turn < 100 && folder.getStatus().unsaved.length > 0; turn++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(folder.getStatus().unsaved).toEqual([]);
		expect(expectOk(await folder.tables.notes.get('milk'))?.fields?.title).toBe(
			'Oat',
		);
		expect(await folder.close()).toEqual([]);
	}
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

test('a native-style save stages beside the root and leaves no .git in the authored folder', async () => {
	const { root, folder } = await granted({ 'note.md': 'one\n' });
	try {
		expectOk(await folder.files.write('note.md', 'one\n', 'two\n'));
		expectOk(await folder.files.write('new/deep.md', null, 'fresh\n'));
		expect(await shell.text('note.md')).toBe('two\n');
		expect(await shell.text('new/deep.md')).toBe('fresh\n');
		// Nothing but the files saved is in the root: no `.git`, no scratch.
		expect((await readdir(root)).sort()).toEqual(['new', 'note.md']);
		expect(existsSync(join(root, '.git'))).toBe(false);
		// What was staged is beside the root, and none of it stays.
		expect(shell.scratch).toBe(
			join(root, '..', `.${basename(root)}.epicenter-scratch`),
		);
		expect(await readdir(shell.scratch)).toEqual([]);
		await folder.close();
	} finally {
		await rm(shell.scratch, { recursive: true, force: true });
	}
});

test('opening sweeps stale staged files beside the root, and leaves younger and foreign ones', async () => {
	const root = await grantedDirectory('native-tauri-');
	shell = createGrantedShell(root);
	try {
		await mkdir(shell.scratch);
		const staged = (offset: number) =>
			`${(Date.now() + offset).toString(36)}-${'0'.repeat(32)}-0`;
		const fresh = staged(0);
		for (const name of [fresh, staged(-2 * 60 * 60 * 1000), 'left-behind'])
			await writeFile(join(shell.scratch, name), 'x');
		// Old scratch inside the root is the previous layout's, not the shell's.
		await mkdir(join(root, '.git/epicenter/scratch'), { recursive: true });
		const old = join(
			root,
			'.git/epicenter/scratch',
			staged(-2 * 60 * 60 * 1000),
		);
		await writeFile(old, 'x');
		const folder = expectOk(await openTauriFolder({ tables: { notes } }));
		expect((await readdir(shell.scratch)).sort()).toEqual(
			[fresh, 'left-behind'].sort(),
		);
		expect(existsSync(old)).toBe(true);
		await folder.close();
	} finally {
		await rm(shell.scratch, { recursive: true, force: true });
	}
});

test('a lost reply is the save landing only when the path holds what was sent', async () => {
	const { folder } = await granted();
	shell.control.loseReplies = 1;
	expectOk(await folder.files.write('a.md', null, 'a'));
	expect(folder.getStatus().storageFailure).toBeNull();

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
	expect(folder.getStatus().storageFailure).toBe(lost as never);
	expect(await shell.text('b.md')).toBe('someone else');
	await folder.close();
});

test('own saves and page peers report paths without native watching', async () => {
	const { folder } = await granted();
	const peer = expectOk(await openTauriFolder({ tables: { notes } }));
	const heard: FolderChange[] = [];
	const others: FolderChange[] = [];
	folder.onChange((change) => heard.push(change));
	peer.onChange((change) => others.push(change));
	expectOk(await folder.files.write('a.md', null, 'a'));
	expect(heard).toEqual([{ paths: ['a.md'], origin: 'this-handle' }]);
	expect(others).toEqual([{ paths: ['a.md'], origin: 'other-handle' }]);
	await folder.close();
	expectOk(await peer.files.write('b.md', null, 'b'));
	expect(heard).toHaveLength(1);
	await peer.close();
});
