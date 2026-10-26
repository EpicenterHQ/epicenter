/** A folder over a real directory, through the directory storage contract. */
import { afterEach, expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
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
