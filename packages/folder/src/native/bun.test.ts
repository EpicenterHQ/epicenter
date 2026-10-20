/**
 * The native `Folder` over a directory Bun names: `openBunFolder`.
 *
 * Key behaviors:
 * - Opening an existing directory reads its files as they are and writes none
 * - Git is optional: saving makes no `.git`, and a `.git` file or link opens
 * - Opening clears what a stopped save staged an hour ago beside the directory
 * - On Unix staged bytes are this account's alone, in a `0700` directory (an
 *   open one an older version made is tightened) and a `0600` file; a linked
 *   scratch directory is refused and the directory it names is not changed
 * - On macOS neither keeps an access control entry the parent passes on; one
 *   that cannot be removed refuses the save before anything is staged
 * - A replaced file keeps its mode; a new file is `0600`
 * - Saves take the save lock other processes and the desktop shell take
 * - Rows keep exact source, unknown fields, comments, and repairable frontmatter
 * - Every save is guarded by the bytes it read, and merges what landed meanwhile
 * - Structural refusals are results, not storage failures
 * - A row delete keeps adjacent files, and an unseen edit keeps the row
 * - Saves notify this handle and the directory's other handles in this process
 * - Status reports saving and the last storage failure until a later success
 * - Close lets started saves finish, then stops listening; new calls throw
 */
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
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
import type { FolderChange, FolderStatus } from '../folder.js';
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

test('the pause a directory is opened with saves its held input', async () => {
	const root = await directory({ 'notes/milk.md': '---\ntitle: Milk\n---\n' });
	const folder = expectOk(
		await openBunFolder({ directory: root, tables: { notes }, saveAfterMs: 5 }),
	);
	const row = expectOk(await folder.tables.notes.get('milk'))!;
	folder.tables.notes.edit('milk').change(row, { fields: { title: 'Oat' } });
	expect(folder.status.unsaved).toEqual(['notes/milk.md']);
	for (let turn = 0; turn < 100 && folder.status.unsaved.length > 0; turn++)
		await new Promise((resolve) => setTimeout(resolve, 5));
	expect(await text(root, 'notes/milk.md')).toBe('---\ntitle: Oat\n---\n');
	expect(await folder.close()).toEqual([]);
});

test('binary saves keep exact bytes and preserve the input captured at call time', async () => {
	const root = await directory();
	const folder = await open(root);
	const bytes = new Uint8Array([0, 1, 255]);
	const saving = folder.files.write('audio/clip.bin', null, bytes);
	bytes[1] = 9;
	expectOk(await saving);
	expect(new Uint8Array(await readFile(join(root, 'audio/clip.bin')))).toEqual(
		new Uint8Array([0, 1, 255]),
	);
	await folder.close();
});

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

test('existing empty and nonportable row stems remain visible for repair', async () => {
	const root = await directory({
		'notes/.md': '---\ntitle: Empty\n---\nBody\n',
		'notes/a: b.md': '---\ntitle: Colon\n---\nBody\n',
	});
	const folder = await open(root);
	expect(expectOk(await folder.tables.notes.list()).map((row) => row.id)).toEqual(['', 'a: b']);
	expect(expectOk(await folder.tables.notes.get(''))?.fields).toEqual({ title: 'Empty' });
	const raw = expectOk(await folder.tables.notes.get('a: b'))!;
	expect(raw.fields).toEqual({ title: 'Colon' });
	expect(expectErr(await folder.tables.notes.set('', null, { body: 'new' })).name).toBe('InvalidId');
	expect(expectErr(await folder.tables.notes.set('a: b', null, { body: 'new' })).name).toBe('InvalidId');
	const { sent } = expectOk(await folder.tables.notes.set('a: b', raw, { body: 'Repaired\n' }));
	expect(await text(root, 'notes/a: b.md')).toContain('Repaired');
	expect(expectOk(await folder.tables.notes.delete('a: b', sent))).toEqual({ deleted: true });
	expect(await text(root, 'notes/a: b.md')).toBeUndefined();
	expect(expectErr(await folder.tables.notes.set('a: b', raw, { body: 'again' })).name).toBe('InvalidPath');
	await folder.close();
});

test('an existing HEAD is readable but cannot be changed into Git state', async () => {
	const root = await directory({ HEAD: 'notes\n' });
	const folder = await open(root);
	expect(await expectOk(await folder.files.read('HEAD'))?.content.text()).toBe('notes\n');
	expect(expectErr(await folder.files.write('HEAD', 'notes\n', 'ref: refs/heads/main\n')).name).toBe('InvalidPath');
	expect(expectErr(await folder.files.delete('HEAD', 'notes\n')).name).toBe('InvalidPath');
	expect(await text(root, 'HEAD')).toBe('notes\n');
	await folder.close();
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
	expectOk(await folder.files.write('notes/one/x.txt', null, 'x'));
	expectOk(await folder.tables.notes.delete('one', sent));
	expectOk(await folder.files.delete('docs/a.md', 'a\n'));
	expect((await readdir(root)).sort()).toEqual(['docs', 'notes', 'readme.txt']);
	expect(await readdir(join(root, 'notes'))).toEqual(['one']);
	expect(expectOk(await folder.files.list())).toEqual(['notes/one/x.txt', 'readme.txt']);
	// What a save staged went beside the directory, and none of it stays.
	expect(await readdir(join(root, '..', '.folder.epicenter-scratch'))).toEqual(
		[],
	);
	await folder.close();
});

test('opening clears what a stopped save staged an hour ago, and leaves younger and foreign files', async () => {
	const root = await directory();
	const scratch = join(root, '..', '.folder.epicenter-scratch');
	await mkdir(scratch);
	if (process.platform !== 'win32') await chmod(scratch, 0o755);
	/** A staged file's name as another process's handle makes it, `offset` ms from now. */
	const staged = (offset: number) =>
		`${(Date.now() + offset).toString(36)}-${'0'.repeat(32)}-0`;
	// Another process may still be about to rename the young one into place.
	const fresh = staged(0);
	for (const name of [fresh, staged(-2 * 60 * 60 * 1000), 'left-behind'])
		await writeFile(join(scratch, name), 'x');
	const folder = await open(root);
	if (process.platform !== 'win32')
		expect((await lstat(scratch)).mode & 0o777).toBe(0o700);
	expect((await readdir(scratch)).sort()).toEqual(
		[fresh, 'left-behind'].sort(),
	);
	expect(await readdir(root)).toEqual([]);
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

/** The permission bits at `path`. */
const mode = async (path: string) => (await lstat(path)).mode & 0o777;

test.skipIf(process.platform === 'win32')(
	"staged bytes are this account's alone while a save waits, and a replaced file keeps its mode",
	async () => {
		const root = await directory({
			'shared.md': 'old\n',
			'private.md': 'mine\n',
			'tool.sh': '#!/bin/sh\n',
		});
		await chmod(join(root, 'shared.md'), 0o644);
		await chmod(join(root, 'private.md'), 0o600);
		await chmod(join(root, 'tool.sh'), 0o755);
		// An older version made the scratch directory open to everyone.
		const staging = join(root, '..', '.folder.epicenter-scratch');
		await mkdir(staging);
		await chmod(staging, 0o755);
		const folder = await open(root);

		// Another program holds the save lock, so the save stops with its
		// bytes staged, as a save a quit stops there leaves them.
		const other = new Database(
			join(root, '..', '.folder.epicenter-save-lock'),
			{ create: true },
		);
		other.run('BEGIN EXCLUSIVE');
		const saving = folder.files.write('shared.md', 'old\n', 'secret\n');
		let staged: string[] = [];
		let stagedText = '';
		for (let tries = 0; stagedText !== 'secret\n' && tries < 200; tries++) {
			await Bun.sleep(10);
			staged = await readdir(staging);
			if (staged.length === 1)
				stagedText = await readFile(join(staging, staged[0]!), 'utf8');
		}
		expect(staged).toHaveLength(1);
		const file = join(staging, staged[0]!);
		expect(await mode(staging)).toBe(0o700);
		expect(await mode(file)).toBe(0o600);
		expect(stagedText).toBe('secret\n');
		expect(await text(root, 'shared.md')).toBe('old\n');
		other.run('ROLLBACK');
		other.close();
		expectOk(await saving);

		expectOk(await folder.files.write('private.md', 'mine\n', 'still mine\n'));
		expectOk(
			await folder.files.write('tool.sh', '#!/bin/sh\n', '#!/bin/bash\n'),
		);
		expectOk(await folder.files.write('fresh.md', null, 'new\n'));
		for (const [path, content, bits] of [
			['shared.md', 'secret\n', 0o644],
			['private.md', 'still mine\n', 0o600],
			['tool.sh', '#!/bin/bash\n', 0o755],
			['fresh.md', 'new\n', 0o600],
		] as const) {
			expect(await text(root, path)).toBe(content);
			expect(await mode(join(root, path))).toBe(bits);
		}
		expect(await readdir(staging)).toEqual([]);
		expect(await mode(staging)).toBe(0o700);
		await folder.close();
	},
);

/**
 * The access control entries `ls` lists on `path`, which it does not
 * follow: one line each after the entry's own.
 */
const acl = (path: string) =>
	execFileSync('/bin/ls', ['-ldeq', path], { encoding: 'utf8' })
		.split('\n')
		.slice(1)
		.filter((line) => /^\s*\d+: /.test(line));

/**
 * Give `directory` an entry that lets every account list and read what is
 * made in it from now on, as a shared parent can.
 */
const shareWithEveryone = (directory: string) =>
	execFileSync('/bin/chmod', [
		'+a',
		'everyone allow list,search,read,file_inherit,directory_inherit',
		directory,
	]);

const darwin = process.platform === 'darwin';

test.skipIf(!darwin)(
	'staged bytes keep no access control entry the parent passes on',
	async () => {
		const root = await directory({ 'shared.md': 'old\n' });
		const parent = join(root, '..');
		shareWithEveryone(parent);
		// The parent passes it on, as it would to the scratch directory.
		const probe = join(parent, 'probe');
		await mkdir(probe, { mode: 0o700 });
		expect(acl(probe).join('\n')).toContain('everyone inherited allow');
		const folder = await open(root);

		const other = new Database(join(parent, '.folder.epicenter-save-lock'), {
			create: true,
		});
		other.run('BEGIN EXCLUSIVE');
		const saving = folder.files.write('shared.md', 'old\n', 'secret\n');
		const staging = join(parent, '.folder.epicenter-scratch');
		let staged: string[] = [];
		let stagedText = '';
		// Creation precedes the write. Wait for the bytes whose permissions we inspect.
		for (let tries = 0; stagedText !== 'secret\n' && tries < 200; tries++) {
			await Bun.sleep(10);
			staged = await readdir(staging).catch(() => []);
			if (staged.length === 1) {
				stagedText = await readFile(join(staging, staged[0]!), 'utf8');
			}
		}
		expect(staged).toHaveLength(1);
		const file = join(staging, staged[0]!);
		expect([await mode(staging), acl(staging)]).toEqual([0o700, []]);
		expect([await mode(file), acl(file)]).toEqual([0o600, []]);
		expect(await readFile(file, 'utf8')).toBe('secret\n');
		other.run('ROLLBACK');
		other.close();
		expectOk(await saving);

		expect(await text(root, 'shared.md')).toBe('secret\n');
		expect(await readdir(staging)).toEqual([]);
		expect(acl(staging)).toEqual([]);
		await folder.close();
	},
);

test.skipIf(!darwin)(
	'opening removes the access control entry an existing scratch directory inherited',
	async () => {
		const root = await directory();
		const parent = join(root, '..');
		shareWithEveryone(parent);
		const staging = join(parent, '.folder.epicenter-scratch');
		await mkdir(staging, { mode: 0o700 });
		expect(acl(staging)).not.toEqual([]);
		const folder = await open(root);
		expect([await mode(staging), acl(staging)]).toEqual([0o700, []]);
		await folder.close();
	},
);

test.skipIf(!darwin)(
	'a scratch directory whose access control entry stays refuses the save before staging',
	async () => {
		const root = await directory({ 'a.md': 'accepted\n' });
		const parent = join(root, '..');
		shareWithEveryone(parent);
		const staging = join(parent, '.folder.epicenter-scratch');
		await mkdir(staging, { mode: 0o700 });
		// The user immutable flag keeps the entry from being removed.
		execFileSync('/usr/bin/chflags', ['uchg', staging]);
		try {
			const folder = await open(root);
			const refused = expectErr(
				await folder.files.write('a.md', 'accepted\n', 'mine\n'),
			);
			expect(JSON.stringify(refused)).toContain('could not be made private');
			expect(await text(root, 'a.md')).toBe('accepted\n');
			expect(await readdir(staging)).toEqual([]);
			await folder.close();
		} finally {
			execFileSync('/usr/bin/chflags', ['nouchg', staging]);
		}
	},
);

test.skipIf(process.platform === 'win32')(
	'a scratch directory that is a link is never staged in or changed through',
	async () => {
		const root = await directory({ 'a.md': 'old\n' });
		const elsewhere = join(root, '..', 'elsewhere');
		await mkdir(elsewhere);
		await chmod(elsewhere, 0o755);
		await symlink(elsewhere, join(root, '..', '.folder.epicenter-scratch'));
		const folder = await open(root);
		const refused = expectErr(
			await folder.files.write('a.md', 'old\n', 'new\n'),
		);
		expect(JSON.stringify(refused)).toContain('symbolic link');
		expect(await text(root, 'a.md')).toBe('old\n');
		expect(await readdir(elsewhere)).toEqual([]);
		expect(await mode(elsewhere)).toBe(0o755);
		await folder.close();
	},
);

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
		await refused(folder.files.write('notes//x.txt', null, 'x')),
	).toBe('InvalidPath');
	expect(folder.status).toEqual({
		saving: false,
		storageFailure: null,
		unsaved: [],
		failures: [],
		closing: false,
	});
	expect(await text(root, 'keep.md')).toBe('keep');
	await folder.close();
});

test('a row delete keeps adjacent files, and an unseen edit keeps the row', async () => {
	const root = await directory({ 'keep.md': 'keep' });
	const folder = await open(root);
	const table = folder.tables.notes;
	const { sent: before } = expectOk(
		await table.set('one', null, { fields: { title: 'Before' } }),
	);
	expectOk(await folder.files.write('notes/one/nested/a.txt', null, 'attachment'));
	expect(expectOk(await folder.files.list('notes/one/'))).toEqual(['notes/one/nested/a.txt']);
	const { sent: edited } = expectOk(
		await table.set('one', before, { fields: { title: 'After' } }),
	);
	expect(expectOk(await table.delete('one', before))).toEqual({
		deleted: false,
	});
	expect(expectOk(await folder.files.list('notes/one/'))).toEqual(['notes/one/nested/a.txt']);
	expect(expectOk(await table.delete('one', edited))).toEqual({
		deleted: true,
	});
	expect(expectOk(await folder.files.list())).toEqual(['keep.md', 'notes/one/nested/a.txt']);
	expect(await text(root, 'notes/one/nested/a.txt')).toBe('attachment');
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
	// A save whose content was already stored tells only its own handle, so
	// its readers reread; nothing changed for the others.
	expectOk(await first.files.write('a.md', 'a', 'a'));
	expect(heard).toEqual([
		{ paths: ['a.md'], origin: 'this-handle' },
		{ paths: ['a.md'], origin: 'this-handle' },
	]);
	expect(heardElsewhere).toHaveLength(1);
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
		saving: false,
		storageFailure: null,
		unsaved: [],
		failures: [],
		closing: false,
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
