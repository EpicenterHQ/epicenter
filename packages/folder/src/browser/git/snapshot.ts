/** Current files from a tree, and path edits applied without a checkout or index. */

import {
	type GitObject,
	hashObject,
	readTree,
	type TreeEntry,
	writeTree,
} from '../../git/raw-objects.js';
import type { FileContent } from '../../shared/merge.js';

/** Git's canonical empty tree, also used for an uncommitted empty folder. */
export const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type SnapshotFile = { oid: string; mode: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const isTree = (mode: string) => mode === '40000' || mode === '040000';

function nameOf(bytes: Uint8Array): string | undefined {
	try {
		return decoder.decode(bytes);
	} catch {
		return undefined;
	}
}

async function objectOf(
	oid: string,
	type: GitObject['type'],
	read: (oid: string) => Promise<GitObject>,
) {
	const object = await read(oid);
	if (object === undefined || object === null)
		throw new Error(`Missing ${type} object ${oid}`);
	if (object.type !== type)
		throw new Error(`Expected ${type} object ${oid}, found ${object.type}`);
	return object;
}

function entriesOf(oid: string, object: GitObject): TreeEntry[] {
	let entries: TreeEntry[];
	try {
		entries = readTree(object.bytes);
	} catch (cause) {
		throw new Error(`Malformed tree object ${oid}`, { cause });
	}
	const names = new Set<string>();
	for (const { name } of entries) {
		if (
			name.length === 0 ||
			name.includes(0x2f) ||
			(name.length === 1 && name[0] === 0x2e) ||
			(name.length === 2 && name[0] === 0x2e && name[1] === 0x2e)
		)
			throw new Error(`Malformed tree object ${oid}: invalid entry name`);
		const key = Array.from(name, (byte) =>
			byte.toString(16).padStart(2, '0'),
		).join('');
		if (names.has(key))
			throw new Error(`Malformed tree object ${oid}: duplicate entry name`);
		names.add(key);
	}
	return entries;
}

/**
 * With no descent filter, walk every nested tree, including raw hidden paths.
 * A filtered read retains unexpanded directory occupancy without reading its
 * children. It is an operation's view, not a complete object closure for GC.
 * Only valid UTF-8 paths outside .git enter files; links remain leaves.
 */
export async function readSnapshot(
	root: string | null,
	read: (oid: string) => Promise<GitObject>,
	descend?: (path: string) => boolean,
): Promise<{
	files: Map<string, SnapshotFile>;
	directories: Set<string>;
}> {
	const files = new Map<string, SnapshotFile>();
	const directories = new Set<string>();
	if (root === null) return { files, directories };
	const trees = new Map<string, TreeEntry[]>();
	const ancestors = new Set<string>();
	async function visit(oid: string, prefix: string | undefined) {
		if (ancestors.has(oid))
			throw new Error(`Malformed tree object ${oid}: cyclic tree reference`);
		let entries = trees.get(oid);
		if (entries === undefined) {
			entries = entriesOf(oid, await objectOf(oid, 'tree', read));
			trees.set(oid, entries);
		}
		ancestors.add(oid);
		for (const entry of entries) {
			const name = nameOf(entry.name);
			const path =
				prefix !== undefined &&
				name !== undefined &&
				name.toLowerCase() !== '.git'
					? `${prefix}${name}`
					: undefined;
			if (isTree(entry.mode)) {
				if (path !== undefined) directories.add(path);
				if (descend === undefined || (path !== undefined && descend(path)))
					await visit(entry.oid, path === undefined ? undefined : `${path}/`);
			} else if (path !== undefined)
				files.set(path, { oid: entry.oid, mode: entry.mode });
		}
		ancestors.delete(oid);
	}
	await visit(root, '');
	return { files, directories };
}

type PathEdit = {
	value: FileContent | null | undefined;
	children: Map<string, PathEdit>;
};

/**
 * Rebuild only trees touched by edits and return the new inflated objects.
 * Existing raw names and modes survive. Edited executables keep their mode;
 * replacing a link writes an ordinary file. Edits contain validated paths.
 */
export async function changeSnapshot({
	root,
	edits,
	read,
}: {
	root: string | null;
	edits: ReadonlyMap<string, FileContent | null>;
	read: (oid: string) => Promise<GitObject>;
}): Promise<{ tree: string; objects: Map<string, GitObject> }> {
	const patch: PathEdit = { value: undefined, children: new Map() };
	for (const [path, value] of edits) {
		let node = patch;
		for (const name of path.split('/')) {
			let child = node.children.get(name);
			if (child === undefined) {
				child = { value: undefined, children: new Map() };
				node.children.set(name, child);
			}
			node = child;
		}
		node.value = value;
	}
	function validate(node: PathEdit, prefix: string, fileAncestor?: string) {
		if (
			node.value !== null &&
			node.value !== undefined &&
			fileAncestor !== undefined
		)
			throw new Error(
				`Conflicting snapshot edits: file ${fileAncestor} also has descendant ${prefix}`,
			);
		for (const [name, child] of node.children)
			validate(
				child,
				prefix === '' ? name : `${prefix}/${name}`,
				node.value !== null && node.value !== undefined ? prefix : fileAncestor,
			);
	}
	validate(patch, '');

	const objects = new Map<string, GitObject>();
	const known = new Set<string>();
	const trees = new Map<string, TreeEntry[]>();
	async function build(
		oid: string | null,
		node: PathEdit,
	): Promise<{ oid: string; empty: boolean }> {
		let before: TreeEntry[] = [];
		if (oid !== null) {
			known.add(oid);
			let entries = trees.get(oid);
			if (entries === undefined) {
				entries = entriesOf(oid, await objectOf(oid, 'tree', read));
				trees.set(oid, entries);
			}
			before = entries;
			for (const entry of entries) known.add(entry.oid);
		}
		const entries = node.value === null ? [] : [...before];
		for (const [name, child] of node.children) {
			const index = entries.findIndex((entry) => nameOf(entry.name) === name);
			const existing = entries[index];
			let next: TreeEntry | undefined;
			if (child.value !== null && child.value !== undefined) {
				const object: GitObject = {
					type: 'blob',
					bytes:
						typeof child.value === 'string'
							? encoder.encode(child.value)
							: child.value,
				};
				const blob = await hashObject(object);
				objects.set(blob, object);
				next = {
					name: encoder.encode(name),
					oid: blob,
					mode: existing?.mode === '100755' ? '100755' : '100644',
				};
			} else if (child.children.size > 0) {
				const result = await build(
					existing !== undefined && isTree(existing.mode) ? existing.oid : null,
					child,
				);
				if (!result.empty)
					next = {
						name: encoder.encode(name),
						mode:
							existing !== undefined && isTree(existing.mode)
								? existing.mode
								: '40000',
						oid: result.oid,
					};
				else if (
					child.value !== null &&
					existing !== undefined &&
					(!isTree(existing.mode) || existing.oid === result.oid)
				)
					next = existing;
			} else if (child.value !== null) {
				next = existing;
			}
			if (index >= 0) {
				if (next === undefined) entries.splice(index, 1);
				else entries[index] = next;
			} else if (next !== undefined) entries.push(next);
		}
		const object: GitObject = { type: 'tree', bytes: writeTree(entries) };
		const tree = await hashObject(object);
		if (entries.length > 0 || node === patch) objects.set(tree, object);
		return { oid: tree, empty: entries.length === 0 };
	}
	const result = await build(root, patch);
	for (const oid of known) objects.delete(oid);
	return { tree: result.oid, objects };
}

/**
 * Remove entries that disappeared between a checkpoint and the working tree.
 * Keep checkpoint bytes for surviving leaves: a rejected send is rebased before
 * newer replacements are applied. Raw names are compared as bytes.
 */
export async function withoutDeletedEntries({
	root,
	workingTree,
	read,
}: {
	root: string;
	workingTree: string;
	read: (oid: string) => Promise<GitObject>;
}) {
	const objects = new Map<string, GitObject>();
	const key = (name: Uint8Array) =>
		Array.from(name, (byte) => byte.toString(16).padStart(2, '0')).join('');
	async function prune(before: string, after: string): Promise<string | null> {
		if (before === after) return before;
		const entries = entriesOf(before, await objectOf(before, 'tree', read));
		const current = new Map(
			entriesOf(after, await objectOf(after, 'tree', read)).map((entry) => [
				key(entry.name),
				entry,
			]),
		);
		const kept: TreeEntry[] = [];
		for (const entry of entries) {
			const next = current.get(key(entry.name));
			if (next === undefined || isTree(entry.mode) !== isTree(next.mode))
				continue;
			if (!isTree(entry.mode)) {
				kept.push(entry);
				continue;
			}
			const oid = await prune(entry.oid, next.oid);
			if (oid !== null) kept.push({ ...entry, oid });
		}
		if (kept.length === 0 && entries.length > 0) return null;
		const object: GitObject = { type: 'tree', bytes: writeTree(kept) };
		const oid = await hashObject(object);
		if (oid !== before) objects.set(oid, object);
		return oid;
	}
	return { tree: await prune(root, workingTree), objects };
}
