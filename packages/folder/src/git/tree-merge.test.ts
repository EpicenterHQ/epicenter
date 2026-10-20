/**
 * Tree reconciliation preserves raw Git entries while merging file contents.
 * Folder deletion is evaluated at leaf files, structural collisions take the
 * change, and modes survive independent content changes.
 */
import { expect, test } from 'bun:test';
import { changeSnapshot, readSnapshot } from '../browser/git/snapshot.js';
import { readRow } from '../shared/row.js';
import {
	type GitObject,
	hashObject,
	readTree,
	writeTree,
} from './raw-objects.js';
import { mergeTrees } from './tree-merge.js';

function fixture() {
	const objects = new Map<string, GitObject>();
	const read = async (oid: string) => {
		const object = objects.get(oid);
		if (object === undefined) throw new Error(`Missing test object ${oid}`);
		return object;
	};
	async function changed(
		root: string | null,
		edits: [string, string | null][],
	) {
		const result = await changeSnapshot({ root, edits: new Map(edits), read });
		for (const [oid, object] of result.objects) objects.set(oid, object);
		return result.tree;
	}
	async function merge(
		base: string | null,
		current: string | null,
		change: string | null,
	) {
		const result = await mergeTrees({ base, current, change, read });
		for (const [oid, object] of result.objects) objects.set(oid, object);
		return result;
	}
	const text = async (root: string | null, path: string) => {
		const snapshot = await readSnapshot(root, read);
		const file = snapshot.files.get(path);
		return file === undefined
			? undefined
			: new TextDecoder().decode((await read(file.oid)).bytes);
	};
	return { objects, read, changed, merge, text };
}

test('a folder deletion retains an edited child without resurrecting its unchanged sibling', async () => {
	const f = fixture();
	const base = await f.changed(null, [
		['folder/a.txt', 'a'],
		['folder/b.txt', 'b'],
	]);
	const current = await f.changed(base, [['folder', null]]);
	const change = await f.changed(base, [['folder/a.txt', 'edited']]);
	const merged = await f.merge(base, current, change);
	expect(await f.text(merged.tree, 'folder/a.txt')).toBe('edited');
	expect(await f.text(merged.tree, 'folder/b.txt')).toBeUndefined();
});

test('a file-directory collision takes the change while retaining an unrelated raw entry', async () => {
	const f = fixture();
	const blob: GitObject = { type: 'blob', bytes: new Uint8Array([0xff, 0]) };
	const blobId = await hashObject(blob);
	f.objects.set(blobId, blob);
	const tree: GitObject = {
		type: 'tree',
		bytes: writeTree([
			{ name: new Uint8Array([0xfe]), mode: '100755', oid: blobId },
		]),
	};
	const base = await hashObject(tree);
	f.objects.set(base, tree);
	const current = await f.changed(base, [['path/nested.txt', 'incoming']]);
	const change = await f.changed(base, [['path', 'local']]);
	const merged = await f.merge(base, current, change);
	expect(await f.text(merged.tree, 'path')).toBe('local');
	const raw = readTree((await f.read(merged.tree!)).bytes).find(
		(entry) => entry.name[0] === 0xfe,
	);
	expect(raw).toEqual({
		name: new Uint8Array([0xfe]),
		mode: '100755',
		oid: blobId,
	});
});

test('both directory replacements of a file retain their independent children', async () => {
	const f = fixture();
	const base = await f.changed(null, [['path', 'old file']]);
	const current = await f.changed(base, [
		['path', null],
		['path/remote.txt', 'remote'],
	]);
	const change = await f.changed(base, [
		['path', null],
		['path/local.txt', 'local'],
	]);
	const merged = await f.merge(base, current, change);
	expect(await f.text(merged.tree, 'path/remote.txt')).toBe('remote');
	expect(await f.text(merged.tree, 'path/local.txt')).toBe('local');
});

test('a second merge retains a newer reversal that collapsing the local snapshots would erase', async () => {
	const f = fixture();
	const base = await f.changed(null, [['row.md', '---\ntitle: a\n---\n']]);
	const pending = await f.changed(base, [['row.md', '---\ntitle: b\n---\n']]);
	const remote = await f.changed(base, [['row.md', '---\ntitle: c\n---\n']]);
	const first = await f.merge(base, remote, pending);
	const result = await f.merge(pending, first.tree, base);
	expect(await f.text(result.tree, 'row.md')).toBe('---\ntitle: a\n---\n');
});

test('concurrent Markdown replacements of a directory still merge independent fields', async () => {
	const f = fixture();
	const base = await f.changed(null, [['row.md/child.txt', 'old directory']]);
	const current = await f.changed(base, [
		['row.md', '---\nremote: yes\n---\n'],
	]);
	const change = await f.changed(base, [['row.md', '---\nlocal: yes\n---\n']]);
	const result = await f.merge(base, current, change);
	const text = await f.text(result.tree, 'row.md');
	expect(readRow('row', text!, {}).fields).toEqual({
		remote: 'yes',
		local: 'yes',
	});
});
