/** A folder over a real directory, through the directory storage contract. */
import { afterEach, expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	utimes,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';
import { nodeDirectoryPrimitives } from './directory-node.js';
import { createDirectoryStorage } from './directory-store.js';
import { scratchDirectory } from './native/directory.js';
import { watchDirectory } from './native/watch.js';
import { createFolder } from './folder.js';
import { storageHost } from './storage.js';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
		await rm(scratchDirectory(root), { recursive: true, force: true });
	}
});

test('refresh sees a same-size outside replacement without a hint', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'folder-stamp-')));
	roots.push(root);
	await writeFile(join(root, 'note.txt'), 'old');
	const fixed = new Date('2024-01-01T00:00:00Z');
	await utimes(join(root, 'note.txt'), fixed, fixed);
	const storage = createDirectoryStorage({
		root,
		primitives: nodeDirectoryPrimitives,
		scratch: scratchDirectory(root),
	});
	const folder = expectOk(await createFolder(storageHost(storage), { tables: {} }));
	expect(folder.file('note.txt')?.data).toBe('old');
	await writeFile(join(root, 'replacement'), 'new');
	await utimes(join(root, 'replacement'), fixed, fixed);
	await rename(join(root, 'replacement'), join(root, 'note.txt'));
	await folder.refresh();
	expect(folder.file('note.txt')?.data).toBe('new');
	await writeFile(join(root, 'note.txt'), 'end');
	await utimes(join(root, 'note.txt'), new Date(fixed.getTime() + 1000), new Date(fixed.getTime() + 1000));
	await folder.refresh();
	expect(folder.file('note.txt')?.data).toBe('end');
	await folder.close();
});

test('a native save leaves a stamp that refresh can reuse without reading', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'folder-stamp-')));
	roots.push(root);
	let reads = 0;
	const primitives = {
		...nodeDirectoryPrimitives,
		async readStamped(path: string) {
			reads++;
			return nodeDirectoryPrimitives.readStamped(path);
		},
	};
	const storage = createDirectoryStorage({
		root,
		primitives,
		scratch: scratchDirectory(root),
	});
	const folder = expectOk(await createFolder(storageHost(storage), { tables: {} }));
	expectOk(await folder.write('note.txt', 'saved'));
	const before = reads;
	await folder.refresh();
	expect(reads).toBe(before);
	await folder.close();
});

test('create, update, an outside edit, and close over a directory', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'folder-')));
	roots.push(root);
	await mkdir(join(root, 'notes'));
	await writeFile(join(root, 'notes/a.md'), '---\ntitle: A\n---\nBody\n');
	const storage = createDirectoryStorage({
		root,
		primitives: nodeDirectoryPrimitives,
		scratch: scratchDirectory(root),
	});
	const folder = expectOk(
		await createFolder(storageHost(storage, { watch: watchDirectory(root) }), {
			tables: {
				notes: Type.Object({
					title: Type.String(),
					pinned: Type.Optional(Type.Boolean()),
				}),
			},
		}),
	);
	const notes = folder.tables.notes;

	expect(notes.rows().map((row) => row.fields?.title)).toEqual(['A']);

	expect(
		(await notes.create('b', { fields: { title: 'B' }, body: 'New\n' })).error,
	).toBeNull();
	expect(await readFile(join(root, 'notes/b.md'), 'utf8')).toBe(
		'---\ntitle: B\n---\nNew\n',
	);

	await writeFile(join(root, 'notes/a.md'), '---\ntitle: Outside\n---\nBody\n');
	await folder.refresh();
	const saved = notes.update('a', { fields: { pinned: true } });
	expect((await saved).error).toBeNull();
	expect(await readFile(join(root, 'notes/a.md'), 'utf8')).toBe(
		'---\ntitle: Outside\npinned: true\n---\nBody\n',
	);
	expect(notes.row('a')?.fields).toEqual({ title: 'Outside', pinned: true });

	void notes.update('b', { fields: { title: 'Closing' } });
	await folder.close();
	expect(await readFile(join(root, 'notes/b.md'), 'utf8')).toBe(
		'---\ntitle: Closing\n---\nNew\n',
	);
});
