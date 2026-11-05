/**
 * Reading and editing a commit's tree along a few paths: only the trees on
 * a changed path are read and rewritten, so a write's cost follows its
 * paths, not the size of the repository.
 */
import {
	type GitObjects,
	type PackObject,
	readTree,
	TREE_MODE,
	type TreeEntry,
	treeObject,
} from './objects.js';

/** The file entry at `path` under tree `root`, or null. */
export async function lookup(
	objects: GitObjects,
	root: string | null,
	path: string,
): Promise<TreeEntry | null> {
	let tree = root;
	const parts = path.split('/');
	for (const [index, name] of parts.entries()) {
		if (tree === null) return null;
		const entry = (await readTree(objects, tree))?.find((e) => e.name === name);
		if (!entry) return null;
		if (index === parts.length - 1)
			return entry.mode === TREE_MODE ? null : entry;
		if (entry.mode !== TREE_MODE) return null;
		tree = entry.oid;
	}
	return null;
}

/**
 * `lookup` for many paths of one tree: each tree on the way is read and
 * indexed by name once, so looking up every file of a folder costs one read
 * of that folder, not one per file.
 */
export function treeLookup(objects: GitObjects, root: string | null) {
	const indexed = new Map<string, Promise<Map<string, TreeEntry> | null>>();
	const entriesOf = (oid: string) => {
		let found = indexed.get(oid);
		if (found === undefined) {
			found = readTree(objects, oid).then((entries) =>
				entries === null
					? null
					: new Map(entries.map((entry) => [entry.name, entry])),
			);
			indexed.set(oid, found);
		}
		return found;
	};
	return async (path: string): Promise<TreeEntry | null> => {
		let tree = root;
		const parts = path.split('/');
		for (const [index, name] of parts.entries()) {
			if (tree === null) return null;
			const entry = (await entriesOf(tree))?.get(name);
			if (!entry) return null;
			if (index === parts.length - 1)
				return entry.mode === TREE_MODE ? null : entry;
			if (entry.mode !== TREE_MODE) return null;
			tree = entry.oid;
		}
		return null;
	};
}

/** Every file under tree `root`, below `prefix` (`''` for all), with its path. */
export async function listFiles(
	objects: GitObjects,
	root: string | null,
	prefix: string,
): Promise<(TreeEntry & { path: string })[]> {
	let tree = root;
	const parts = prefix === '' ? [] : prefix.split('/');
	for (const name of parts) {
		if (tree === null) return [];
		const entry = (await readTree(objects, tree))?.find((e) => e.name === name);
		if (!entry || entry.mode !== TREE_MODE) return [];
		tree = entry.oid;
	}
	const out: (TreeEntry & { path: string })[] = [];
	const walk = async (oid: string, dir: string) => {
		for (const entry of (await readTree(objects, oid)) ?? []) {
			const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
			if (entry.mode === TREE_MODE) await walk(entry.oid, path);
			else out.push({ ...entry, path });
		}
	};
	if (tree !== null) await walk(tree, prefix);
	return out;
}

/** A file's new entry, or null to remove it. */
export type Change = { oid: string; mode: string } | null;

/**
 * Apply `changes` (path to entry) to tree `root`, pushing every new tree
 * object onto `written`. Returns the new root, or null when it is empty.
 * Throws when a path runs through a file, or names a folder.
 */
export async function editTree(
	objects: GitObjects,
	root: string | null,
	changes: Map<string, Change>,
	written: PackObject[],
): Promise<string | null> {
	const entries = new Map(
		((root === null ? [] : await readTree(objects, root)) ?? []).map((e) => [
			e.name,
			e,
		]),
	);
	const below = new Map<string, Map<string, Change>>();
	for (const [path, change] of changes) {
		const slash = path.indexOf('/');
		if (slash < 0) {
			if (entries.get(path)?.mode === TREE_MODE)
				throw new Error(`${path} is a folder`);
			if (change === null) entries.delete(path);
			else entries.set(path, { name: path, ...change });
			continue;
		}
		const dir = path.slice(0, slash);
		let sub = below.get(dir);
		if (!sub) {
			sub = new Map();
			below.set(dir, sub);
		}
		sub.set(path.slice(slash + 1), change);
	}
	for (const [dir, sub] of below) {
		const existing = entries.get(dir);
		if (existing && existing.mode !== TREE_MODE)
			throw new Error(`${dir} is a file`);
		const tree = await editTree(objects, existing?.oid ?? null, sub, written);
		if (tree === null) entries.delete(dir);
		else entries.set(dir, { name: dir, mode: TREE_MODE, oid: tree });
	}
	if (entries.size === 0) return null;
	const tree = treeObject(entries.values());
	written.push(tree);
	return tree.oid;
}

/**
 * Every file path whose entry differs between tree `before` and tree
 * `after` (null: an empty tree), sorted: added, removed, or changed. A
 * subtree with the same id on both sides is the same, and is not read.
 */
export async function diffTrees(
	objects: GitObjects,
	before: string | null,
	after: string | null,
): Promise<string[]> {
	const paths: string[] = [];
	const entries = async (tree: string | null) =>
		new Map(
			((tree === null ? [] : await readTree(objects, tree)) ?? []).map(
				(entry) => [entry.name, entry],
			),
		);
	const walk = async (
		left: string | null,
		right: string | null,
		dir: string,
	): Promise<void> => {
		if (left === right) return;
		const [was, now] = await Promise.all([entries(left), entries(right)]);
		for (const name of new Set([...was.keys(), ...now.keys()])) {
			const a = was.get(name);
			const b = now.get(name);
			if (a?.oid === b?.oid && a?.mode === b?.mode) continue;
			const path = dir === '' ? name : `${dir}/${name}`;
			const aTree = a?.mode === TREE_MODE ? a.oid : null;
			const bTree = b?.mode === TREE_MODE ? b.oid : null;
			if (aTree !== null || bTree !== null) await walk(aTree, bTree, path);
			if ((a && a.mode !== TREE_MODE) || (b && b.mode !== TREE_MODE))
				paths.push(path);
		}
	};
	await walk(before, after, '');
	return paths.sort();
}
