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
 */
import { expect, test } from 'bun:test';
import { gitBlobHash } from './hash.js';
import { createTreeStore } from './tree.js';

const set = (entries: Record<string, string | null>): [string[], string | null][] =>
	Object.entries(entries).map(([path, text]) => [path.split('/'), text === null ? null : gitBlobHash(text)]);

test('tree ids equal git write-tree', () => {
	const trees = createTreeStore();
	expect(trees.empty).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
	// `notes.md` sorts before the subtree `notes`, which Git compares as `notes/`.
	const tree = trees.update(trees.empty, set({ 'notes/a.md': 'hello\n', 'b.txt': 'top\n', 'notes.md': 'x\n' }));
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
	const from = trees.update(trees.empty, set({ 'a/x.md': '1', 'a/y.md': '2', 'b/z.md': '3', 'top.md': '4' }));
	const to = trees.update(from, set({ 'a/x.md': 'changed', 'b/z.md': null, 'c/new.md': '5' }));
	expect(trees.diff(from, to).sort()).toEqual(['a/x.md', 'b/z.md', 'c/new.md']);
	expect(trees.diff(from, from)).toEqual([]);
});
