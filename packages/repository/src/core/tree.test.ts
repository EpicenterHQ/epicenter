/**
 * Tree Store Tests
 *
 * A tree id must equal Git's, so a position a device holds names the same
 * snapshot in Git, and a diff must name exactly the paths whose blob differs.
 *
 * Key behaviors:
 * - tree ids equal `git write-tree` for nested paths and Git's name order
 * - a subtree left empty is removed, so deleting every file gives the empty tree
 * - `diff` names changed, added and deleted paths, at any depth
 * - `added` names exactly the trees one tree holds that another lacks, along what differs
 * - a file and a folder never share a name: `collision` names the file a change set would put over a folder or beneath a file, and `update` throws rather than drop an entry
 */
import { describe, expect, test } from 'bun:test';
import { gitBlobHash } from './hash.js';
import { COLLISIONS, createTreeStore } from './tree.js';

const set = (
	entries: Record<string, string | null>,
): [string[], string | null][] =>
	Object.entries(entries).map(([path, text]) => [
		path.split('/'),
		text === null ? null : gitBlobHash(text),
	]);

test('tree ids equal git write-tree', () => {
	const trees = createTreeStore();
	expect(trees.empty).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
	// `notes.md` sorts before the subtree `notes`, which Git compares as `notes/`.
	const tree = trees.update(
		trees.empty,
		set({ 'notes/a.md': 'hello\n', 'b.txt': 'top\n', 'notes.md': 'x\n' }),
	);
	expect(tree).toBe('c194d9f96268e38e852ee829e44f86a3fbffd5c4');
	expect(trees.read(tree, 'notes/a.md')).toBe(gitBlobHash('hello\n'));
	expect(trees.read(tree, 'notes')).toBeNull();
	expect(trees.read(tree, 'notes/a.md/deeper')).toBeNull();
});

test('a subtree left empty is removed', () => {
	const trees = createTreeStore();
	const tree = trees.update(trees.empty, set({ 'a/b/c.md': 'c\n' }));
	expect(trees.update(tree, set({ 'a/b/c.md': null }))).toBe(trees.empty);
});

test('diff names the paths whose blob differs', () => {
	const trees = createTreeStore();
	const from = trees.update(
		trees.empty,
		set({ 'a/x.md': '1', 'a/y.md': '2', 'b/z.md': '3', 'top.md': '4' }),
	);
	const to = trees.update(
		from,
		set({ 'a/x.md': 'changed', 'b/z.md': null, 'c/new.md': '5' }),
	);
	expect(trees.diff(from, to).sort()).toEqual(['a/x.md', 'b/z.md', 'c/new.md']);
	expect(trees.diff(from, from)).toEqual([]);
});

test('added names the trees one tree holds that another lacks, and no shared subtree', () => {
	const trees = createTreeStore();
	const from = trees.update(
		trees.empty,
		set({ 'a/deep/x.md': '1', 'b/y.md': '2' }),
	);
	const to = trees.update(
		from,
		set({ 'a/deep/x.md': 'changed', 'c/new.md': '3' }),
	);
	const sub = (tree: string, name: string) =>
		trees.entries(tree)?.get(name)?.hash as string;
	const a = sub(to, 'a');
	expect(trees.added(from, to).sort()).toEqual(
		[to, a, sub(a, 'deep'), sub(to, 'c')].sort(),
	);
	expect(trees.added(from, to)).not.toContain(sub(to, 'b'));
	expect(trees.added(to, to)).toEqual([]);
	expect(trees.added(trees.empty, from)).toHaveLength(4);
});

describe('a file and a folder never share a name', () => {
	const trees = createTreeStore();
	const folder = trees.update(trees.empty, set({ 'album/photo.png': 'p' }));
	const file = trees.update(trees.empty, set({ album: 'f' }));

	test('collision names the file a change set puts over a folder, or beneath a file', () => {
		expect(trees.collision(folder, set({ album: 'f' }))).toEqual({
			path: 'album',
			code: 'is-a-folder',
		});
		expect(trees.collision(file, set({ 'album/photo.png': 'p' }))).toEqual({
			path: 'album/photo.png',
			code: 'under-a-file',
		});
		expect(
			trees.collision(file, set({ 'album/deeper/photo.png': 'p' })),
		).toEqual({ path: 'album/deeper/photo.png', code: 'under-a-file' });
		expect(
			trees.collision(trees.empty, set({ album: 'f', 'album/photo.png': 'p' })),
		).toEqual({ path: 'album/photo.png', code: 'under-a-file' });
		expect(COLLISIONS).toEqual({
			'is-a-folder': 'a folder already has this name',
			'under-a-file': 'a file already has this name',
		});
	});

	test('a change set that empties the folder may put a file at its name, and one that deletes the file may make it a folder', () => {
		expect(
			trees.collision(folder, set({ album: 'f', 'album/photo.png': null })),
		).toBeNull();
		expect(
			trees.collision(file, set({ album: null, 'album/photo.png': 'p' })),
		).toBeNull();
		expect(
			trees.read(
				trees.update(folder, set({ album: 'f', 'album/photo.png': null })),
				'album',
			),
		).toBe(gitBlobHash('f'));
		expect(
			trees.read(
				trees.update(file, set({ album: null, 'album/photo.png': 'p' })),
				'album/photo.png',
			),
		).toBe(gitBlobHash('p'));
	});

	test('update throws on a collision rather than drop an entry; a delete beneath a file leaves the file, and one naming a folder leaves the folder', () => {
		expect(() => trees.update(folder, set({ album: 'f' }))).toThrow(
			COLLISIONS['is-a-folder'],
		);
		expect(() => trees.update(file, set({ 'album/photo.png': 'p' }))).toThrow(
			COLLISIONS['under-a-file'],
		);
		expect(trees.update(file, set({ 'album/photo.png': null }))).toBe(file);
		expect(trees.update(folder, set({ album: null }))).toBe(folder);
	});

	test('randomized: a change set lands exactly the files it names over the files it leaves, or collides and changes nothing', () => {
		const PATHS = ['a', 'a/b', 'a/c', 'a/b/d', 'a/b/e', 'f', 'f/g'];
		let state = 1;
		const random = () => {
			state = (state * 48271) % 2147483647;
			return state / 2147483647;
		};
		const pick = <T>(items: T[]) =>
			items[Math.floor(random() * items.length)] as T;
		const flat = (tree: string) =>
			new Map(
				trees
					.diff(trees.empty, tree)
					.map((path) => [path, trees.read(tree, path)]),
			);
		/** The definition, apart from the walk: no path in the result is a folder of another. */
		const representable = (files: Map<string, string | null>) =>
			![...files.keys()].some((path) =>
				[...files.keys()].some((other) => other.startsWith(`${path}/`)),
			);
		let tree = trees.empty;
		for (let i = 0; i < 2_000; i++) {
			const changes = new Map<string, string | null>();
			for (let n = 1 + Math.floor(random() * 3); n > 0; n--)
				changes.set(pick(PATHS), random() < 0.3 ? null : pick(['1', '2', '3']));
			const before = flat(tree);
			const expected = new Map(before);
			for (const [path, text] of changes) {
				// A delete names a file; a folder at that name keeps its files.
				if (text === null) expected.delete(path);
				else expected.set(path, gitBlobHash(text));
			}
			const found = trees.collision(tree, set(Object.fromEntries(changes)));
			expect(found === null).toBe(representable(expected));
			if (found !== null) {
				expect(changes.get(found.path)).toBeString();
				expect(() =>
					trees.update(tree, set(Object.fromEntries(changes))),
				).toThrow();
				continue;
			}
			tree = trees.update(tree, set(Object.fromEntries(changes)));
			expect(flat(tree)).toEqual(expected);
		}
	});
});
