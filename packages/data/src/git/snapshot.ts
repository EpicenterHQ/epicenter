/** Current files from a commit, and path edits applied without a checkout or index. */
import {
	type GitObject,
	hashObject,
	readCommit,
	readTree,
	type TreeEntry,
	writeTree,
} from './objects.js';

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
 * Walk every nested tree, including trees whose paths cannot be exposed. Only
 * valid UTF-8 paths outside .git enter files; links remain leaves with their modes.
 */
export async function readSnapshot(
	commit: string | null,
	read: (oid: string) => Promise<GitObject>,
): Promise<{
	root: string | null;
	files: Map<string, SnapshotFile>;
	directories: Set<string>;
	opaqueDirectories: Set<string>;
}> {
	const files = new Map<string, SnapshotFile>();
	const directories = new Set<string>();
	// These directories cannot be reconstructed from the exposed file paths.
	const opaqueDirectories = new Set<string>();
	if (commit === null)
		return { root: null, files, directories, opaqueDirectories };
	const object = await objectOf(commit, 'commit', read);
	let root: string;
	try {
		root = readCommit(object.bytes).tree;
	} catch (cause) {
		throw new Error(`Malformed commit object ${commit}`, { cause });
	}
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
		if (entries.length === 0 && prefix !== undefined && prefix !== '')
			opaqueDirectories.add(prefix.slice(0, -1));
		for (const entry of entries) {
			const name = nameOf(entry.name);
			const path =
				prefix !== undefined &&
				name !== undefined &&
				name.toLowerCase() !== '.git'
					? `${prefix}${name}`
					: undefined;
			if (path === undefined && prefix !== undefined && prefix !== '')
				opaqueDirectories.add(prefix.slice(0, -1));
			if (isTree(entry.mode)) {
				if (path !== undefined) directories.add(path);
				await visit(entry.oid, path === undefined ? undefined : `${path}/`);
			} else if (path !== undefined)
				files.set(path, { oid: entry.oid, mode: entry.mode });
		}
		ancestors.delete(oid);
	}
	await visit(root, '');
	return { root, files, directories, opaqueDirectories };
}

type PathEdit = {
	value: string | null | undefined;
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
	edits: ReadonlyMap<string, string | null>;
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
		if (typeof node.value === 'string' && fileAncestor !== undefined)
			throw new Error(
				`Conflicting snapshot edits: file ${fileAncestor} also has descendant ${prefix}`,
			);
		for (const [name, child] of node.children)
			validate(
				child,
				prefix === '' ? name : `${prefix}/${name}`,
				typeof node.value === 'string' ? prefix : fileAncestor,
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
			if (typeof child.value === 'string') {
				const object: GitObject = {
					type: 'blob',
					bytes: encoder.encode(child.value),
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
