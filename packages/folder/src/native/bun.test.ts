/**
 * The native `Folder` over a directory Bun names: `openBunFolder`.
 *
 * Key behaviors:
 * - Opening an existing directory reads its files as they are and writes none
 * - Git is optional: saving makes no `.git`, and a `.git` file or link opens
 * - Saves take the save lock other processes and the desktop shell take
 * - Rows keep exact source, unknown fields, comments, and repairable frontmatter
 * - Every save is guarded by the bytes it read, and merges what landed meanwhile
 * - Structural refusals are results, not storage failures
 * - A row delete takes its attachment folder, unless an unseen edit kept the row
 * - Saves notify this handle and the directory's other handles in this process
 * - Status reports saving and the last storage failure until a later success
 * - Close lets started saves finish, then stops listening; new calls throw
 */
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { FolderChange, FolderStatus } from '../local-folder.js';
import { openBunFolder } from './bun.js';

const notes = Type.Object({
	title: Type.String(),
	done: Type.Optional(Type.Boolean()),
});

const made: string[] = [];
afterEach(async () => {
	for (const directory of made.splice(0)) {
		await chmod(directory, 0o755).catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
});

async function directory(files: Record<string, string | Uint8Array> = {}) {
	// Each directory in a parent of its own, which holds its lock and scratch.
	const parent = await realpath(
		await mkdtemp(join(tmpdir(), 'native-folder-')),
	);
	made.push(parent);
	const root = join(parent, 'folder');
	await mkdir(root);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), content);
	}
	return root;
}

const open = async (root: string) =>
	expectOk(await openBunFolder({ directory: root, tables: { notes } }));

const text = (root: string, path: string) =>
	readFile(join(root, path), 'utf8').catch(() => undefined);

test('opening an existing directory reads its files as they are and writes none', async () => {
	const binary = new Uint8Array([0, 1, 2, 255]);
	const root = await directory({
		'notes/fits.md': '---\ntitle: Milk\n---\nBody\n',
		'notes/extra.md': '---\n# kept\ntitle: Eggs\nfrom: phone\n---\n',
		'notes/broken.md': '---\ntitle: [unclosed\n---\nStill here\n',
		'notes/wrong.md': '---\ntitle: 3\n---\n',
		'readme.txt': 'plain\n',
		'images/pic.bin': binary,
	});
	const before = await stat(join(root, 'notes/fits.md'));
	const folder = await open(root);

	expect(expectOk(await folder.files.list())).toEqual([
		'images/pic.bin',
		'notes/broken.md',
		'notes/extra.md',
		'notes/fits.md',
		'notes/wrong.md',
		'readme.txt',
	]);
	const rows = expectOk(await folder.tables.notes.list());
	expect(rows.map((row) => row.id).sort()).toEqual([
		'broken',
		'extra',
		'fits',
		'wrong',
	]);
	const fits = rows.find((row) => row.id === 'fits')!;
	expect(fits.issues).toBeNull();
	expect(fits.fields).toEqual({ title: 'Milk' });
	const broken = rows.find((row) => row.id === 'broken')!;
	expect(broken.text).toBe('---\ntitle: [unclosed\n---\nStill here\n');
	expect(broken.issues?.[0]?.kind).toBe('frontmatter');
	expect(rows.find((row) => row.id === 'wrong')!.issues?.[0]?.kind).toBe(
		'schema',
	);
	const read = expectOk(await folder.files.read('images/pic.bin'))!;
	expect(new Uint8Array(await read.content.arrayBuffer())).toEqual(binary);
	expect(expectOk(await folder.files.read('missing.txt'))).toBeUndefined();

	await folder.close();
	expect((await stat(join(root, 'notes/fits.md'))).mtimeMs).toBe(
		before.mtimeMs,
	);
	expect(await text(root, 'notes/broken.md')).toBe(
		'---\ntitle: [unclosed\n---\nStill here\n',
	);
});

test('opening refuses what cannot hold a folder, before acquiring anything', async () => {
	const root = await directory({ 'file.txt': 'x' });
	expect(
		expectErr(
			await openBunFolder({ directory: join(root, 'missing'), tables: {} }),
		).name,
	).toBe('InvalidRoot');
	expect(
		expectErr(
			await openBunFolder({ directory: join(root, 'file.txt'), tables: {} }),
		).name,
	).toBe('InvalidRoot');
	expect(
		expectErr(await openBunFolder({ directory: '/', tables: {} })).name,
	).toBe('InvalidRoot');
	const plain = await directory();
	for (const table of ['', '.git', 'a/b', 'con', '..'])
		expect(
			expectErr(
				await openBunFolder({ directory: plain, tables: { [table]: notes } }),
			),
		).toMatchObject({ name: 'InvalidTable', table });
});

test('opening and saving make no .git, and stage nothing in the directory', async () => {
	const root = await directory({ 'readme.txt': 'plain\n' });
	const folder = await open(root);
	expect(await readdir(root)).toEqual(['readme.txt']);
	const { sent } = expectOk(
		await folder.tables.notes.set('one', null, { fields: { title: 'One' } }),
	);
	expectOk(await folder.files.write('docs/a.md', null, 'a\n'));
	expectOk(await folder.tables.notes.files('one').write('x.txt', null, 'x'));
	expectOk(await folder.tables.notes.delete('one', sent));
	expectOk(await folder.files.delete('docs/a.md', 'a\n'));
	expect((await readdir(root)).sort()).toEqual(['docs', 'notes', 'readme.txt']);
	expect(await readdir(join(root, 'notes'))).toEqual([]);
	expect(expectOk(await folder.files.list())).toEqual(['readme.txt']);
	// What a save staged went beside the directory, and none of it stays.
	expect(await readdir(join(root, '..', '.folder.epicenter-scratch'))).toEqual(
		[],
	);
	await folder.close();
});

test('a .git file or link opens and saves, and is left as it is', async () => {
	const worktree = await directory({
		'.git': 'gitdir: /elsewhere/.git/worktrees/folder\n',
		'notes/one.md': '---\ntitle: One\n---\n',
	});
	const linked = await directory({ 'notes/one.md': '---\ntitle: One\n---\n' });
	await symlink('/nowhere/repository', join(linked, '.git'));
	for (const root of [worktree, linked]) {
		const folder = await open(root);
		expect(expectOk(await folder.files.list())).toEqual(['notes/one.md']);
		const row = expectOk(await folder.tables.notes.get('one'))!;
		expectOk(
			await folder.tables.notes.set('one', row, { fields: { done: true } }),
		);
		expectOk(await folder.files.write('new.md', null, 'new\n'));
		expect(await text(root, 'notes/one.md')).toBe(
			'---\ntitle: One\ndone: true\n---\n',
		);
		expect(await text(root, 'new.md')).toBe('new\n');
		await folder.close();
	}
	expect(await text(worktree, '.git')).toBe(
		'gitdir: /elsewhere/.git/worktrees/folder\n',
	);
	expect((await lstat(join(linked, '.git'))).isSymbolicLink()).toBe(true);
	expect(await readlink(join(linked, '.git'))).toBe('/nowhere/repository');
});

test('a save waits for the save lock another program holds', async () => {
	const root = await directory();
	const folder = await open(root);
	const other = new Database(join(root, '..', '.folder.epicenter-save-lock'), {
		create: true,
	});
	other.run('BEGIN EXCLUSIVE');
	let landed = false;
	const saving = folder.files
		.write('a.md', null, 'a')
		.finally(() => (landed = true));
	await Bun.sleep(200);
	expect(landed).toBe(false);
	expect(await text(root, 'a.md')).toBeUndefined();
	other.run('ROLLBACK');
	other.close();
	expectOk(await saving);
	expect(await text(root, 'a.md')).toBe('a');
	await folder.close();
});

test('a field edit keeps unknown fields and comments, and a schema never refuses', async () => {
	const root = await directory({
		'notes/extra.md': '---\n# kept\ntitle: Eggs\nfrom: phone\n---\nBody\n',
	});
	const folder = await open(root);
	const row = expectOk(await folder.tables.notes.get('extra'))!;
	const { sent } = expectOk(
		await folder.tables.notes.set('extra', row, { fields: { done: true } }),
	);
	expect(await text(root, 'notes/extra.md')).toBe(
		'---\n# kept\ntitle: Eggs\nfrom: phone\ndone: true\n---\nBody\n',
	);
	expect(await text(root, 'notes/extra.md')).toBe(sent.text);
	// A value the schema refuses is still saved, and reads back with its issue.
	const { sent: wrong } = expectOk(
		await folder.tables.notes.set('extra', sent, { fields: { title: 7 } }),
	);
	expect(wrong.issues?.[0]?.kind).toBe('schema');
	expect(await text(root, 'notes/extra.md')).toContain('title: 7');
	await folder.close();
});

test('malformed frontmatter stays repairable: a body edit lands, a field edit is refused', async () => {
	const source = '---\ntitle: [unclosed\n---\nOld\n';
	const root = await directory({ 'notes/broken.md': source });
	const folder = await open(root);
	const row = expectOk(await folder.tables.notes.get('broken'))!;
	expect(
		expectErr(
			await folder.tables.notes.set('broken', row, { fields: { done: true } }),
		).name,
	).toBe('Unparseable');
	expect(await text(root, 'notes/broken.md')).toBe(source);
	expectOk(await folder.tables.notes.set('broken', row, { body: 'New\n' }));
	expect(await text(root, 'notes/broken.md')).toBe(
		'---\ntitle: [unclosed\n---\nNew\n',
	);
	expect(folder.status.storageFailure).toBeNull();
	await folder.close();
});

test('a save merges an edit another program landed after the read', async () => {
	const initial = 'One\n\nMiddle\n\nLast\n';
	const root = await directory({ 'note.md': initial });
	const folder = await open(root);
	// Another program edits the last paragraph after this caller read.
	await writeFile(join(root, 'note.md'), initial.replace('Last', 'Phone'));
	expectOk(
		await folder.files.write(
			'note.md',
			initial,
			initial.replace('One', 'Laptop'),
		),
	);
	expect(await text(root, 'note.md')).toBe('Laptop\n\nMiddle\n\nPhone\n');
	// A delete that did not see the latest edit keeps it.
	expect(expectOk(await folder.files.delete('note.md', initial))).toEqual({
		deleted: false,
	});
	expect(await text(root, 'note.md')).toBe('Laptop\n\nMiddle\n\nPhone\n');
	expect(
		expectOk(
			await folder.files.delete('note.md', 'Laptop\n\nMiddle\n\nPhone\n'),
		),
	).toEqual({ deleted: true });
	expect(await text(root, 'note.md')).toBeUndefined();
	// A new file where another program made one first merges with it.
	await writeFile(join(root, 'new.md'), 'theirs\n');
	expectOk(await folder.files.write('new.md', null, 'mine\n'));
	expect(await text(root, 'new.md')).toContain('mine');
	await folder.close();
});

test('structural refusals are results, and none is a storage failure', async () => {
	const root = await directory({ 'docs/A.md': 'A', 'keep.md': 'keep' });
	const folder = await open(root);
	const refused = async (saving: Promise<{ error: { name: string } | null }>) =>
		(await saving).error?.name;
	expect(await refused(folder.files.write('DOCS/B.md', null, 'B'))).toBe(
		'CaseTwin',
	);
	expect(await refused(folder.files.write('docs/a.md', null, 'a'))).toBe(
		'CaseTwin',
	);
	expect(await refused(folder.files.write('docs', null, 'x'))).toBe('Occupied');
	expect(await refused(folder.files.write('keep.md/child', null, 'x'))).toBe(
		'Occupied',
	);
	for (const path of ['/bad', 'a//b', '../a', 'a/.git/config', 'con.md', 'a.'])
		expect(await refused(folder.files.write(path, null, 'x'))).toBe(
			'InvalidPath',
		);
	expect(await refused(folder.files.write('keep.md', 'keep', '\0'))).toBe(
		'NotText',
	);
	expect(
		await refused(folder.tables.notes.set('a/b', null, { body: 'x' })),
	).toBe('InvalidId');
	expect(
		await refused(folder.tables.notes.files('').write('x.txt', null, 'x')),
	).toBe('InvalidId');
	expect(folder.status).toEqual({
		state: 'local',
		saving: false,
		storageFailure: null,
	});
	expect(await text(root, 'keep.md')).toBe('keep');
	await folder.close();
});

test('a row delete removes its attachment folder, unless an unseen edit kept the row', async () => {
	const root = await directory({ 'keep.md': 'keep' });
	const folder = await open(root);
	const table = folder.tables.notes;
	const { sent: before } = expectOk(
		await table.set('one', null, { fields: { title: 'Before' } }),
	);
	expectOk(await table.files('one').write('nested/a.txt', null, 'attachment'));
	expect(expectOk(await table.files('one').list())).toEqual(['nested/a.txt']);
	const { sent: edited } = expectOk(
		await table.set('one', before, { fields: { title: 'After' } }),
	);
	expect(expectOk(await table.delete('one', before))).toEqual({
		deleted: false,
	});
	expect(expectOk(await table.files('one').list())).toEqual(['nested/a.txt']);
	expect(expectOk(await table.delete('one', edited))).toEqual({
		deleted: true,
	});
	expect(expectOk(await folder.files.list())).toEqual(['keep.md']);
	expect(await stat(join(root, 'notes/one')).catch(() => undefined)).toBe(
		undefined,
	);
	expect(expectOk(await table.list())).toEqual([]);
	await folder.close();
});

test('a save notifies this handle and the directory’s other handles in this process', async () => {
	const root = await directory();
	const first = await open(root);
	const second = await open(root);
	const heard: FolderChange[] = [];
	const heardElsewhere: FolderChange[] = [];
	first.onChange((change) => heard.push(change));
	const stop = second.onChange((change) => heardElsewhere.push(change));
	expectOk(await first.files.write('a.md', null, 'a'));
	expect(heard).toEqual([{ paths: ['a.md'], origin: 'this-handle' }]);
	expect(heardElsewhere).toEqual([{ paths: ['a.md'], origin: 'other-handle' }]);
	// A no-op save changes nothing and tells nobody.
	expectOk(await first.files.write('a.md', 'a', 'a'));
	expect(heard).toHaveLength(1);
	stop();
	await second.close();
	expectOk(await first.files.write('b.md', null, 'b'));
	expect(heardElsewhere).toHaveLength(1);
	// A listener that throws does not fail the save.
	first.onChange(() => {
		throw new Error('listener bug');
	});
	expectOk(await first.files.write('c.md', null, 'c'));
	await first.close();
});

test('status shows saving and the last storage failure until a later success', async () => {
	const root = await directory();
	const folder = await open(root);
	const seen: FolderStatus[] = [];
	folder.onStatusChange((status) => seen.push(status));
	const saving = folder.files.write('a.md', null, 'a');
	expect(folder.status.saving).toBe(true);
	expectOk(await saving);
	expect(folder.status).toEqual({
		state: 'local',
		saving: false,
		storageFailure: null,
	});

	await chmod(root, 0o555);
	const failed = expectErr(await folder.files.write('b.md', null, 'b'));
	expect(failed.name).toBe('StorageFailed');
	expect(folder.status.storageFailure).toBe(failed as never);
	expect(await text(root, 'b.md')).toBeUndefined();
	await chmod(root, 0o755);
	expectOk(await folder.files.write('b.md', null, 'b'));
	expect(folder.status.storageFailure).toBeNull();
	expect(seen.map((status) => status.saving)).toEqual([
		true,
		false,
		true,
		false,
		true,
		false,
	]);
	await folder.close();
});

test('close lets a started save finish, then stops listening; new calls throw', async () => {
	const root = await directory();
	const folder = await open(root);
	const heard: FolderChange[] = [];
	folder.onChange((change) => heard.push(change));
	const saving = folder.files.write('a.md', null, 'a');
	const closing = folder.close();
	expect(folder.close()).toBe(closing);
	expectOk(await saving);
	await closing;
	expect(await text(root, 'a.md')).toBe('a');
	expect(heard).toHaveLength(1);
	expect(() => folder.files.list()).toThrow('The folder is closed');
	expect(() => folder.onChange(() => {})).toThrow('The folder is closed');
});
