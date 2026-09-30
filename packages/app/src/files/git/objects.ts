/**
 * Git object work shared by the browser and native backends.
 *
 * These functions write and read immutable objects only. They never touch the
 * index or move a ref, so a checkpoint can build its tree and commit without
 * the shared index that isomorphic-git writes without `index.lock`.
 */
import * as git from 'isomorphic-git';
import type { PathChange } from './messages.js';

export type ObjectAccess = {
	readonly fs: git.PromiseFsClient;
	readonly gitdir: string;
	readonly cache?: object;
};

export type TreeFile = { readonly oid: string; readonly mode: string };

export type Author = {
	readonly name: string;
	readonly email: string;
};

export type CommitSummary = {
	readonly oid: string;
	readonly parents: readonly string[];
	readonly message: string;
	readonly author: Author & { readonly timestamp: number };
};

/** Git's empty tree, which every repository can name without storing it. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Write every file as a blob and the directories as trees. Returns the root tree. */
export async function writeFilesTree(
	access: ObjectAccess,
	files: ReadonlyMap<string, Uint8Array>,
): Promise<string> {
	type Directory = {
		files: Map<string, Uint8Array>;
		directories: Map<string, Directory>;
	};
	const root: Directory = { files: new Map(), directories: new Map() };
	for (const [path, bytes] of files) {
		const parts = path.split('/');
		let directory = root;
		for (const part of parts.slice(0, -1)) {
			let child = directory.directories.get(part);
			if (child === undefined) {
				child = { files: new Map(), directories: new Map() };
				directory.directories.set(part, child);
			}
			directory = child;
		}
		directory.files.set(parts[parts.length - 1]!, bytes);
	}
	async function write(directory: Directory): Promise<string> {
		const entries: git.TreeEntry[] = [];
		for (const [name, bytes] of directory.files)
			entries.push({
				path: name,
				mode: '100644',
				type: 'blob',
				oid: await git.writeBlob({ ...access, blob: bytes }),
			});
		for (const [name, child] of directory.directories)
			entries.push({
				path: name,
				mode: '040000',
				type: 'tree',
				oid: await write(child),
			});
		// An empty root still writes the empty tree so a commit naming it can be pushed.
		return git.writeTree({ ...access, tree: entries });
	}
	return write(root);
}

/** Git blob IDs for captured bytes, without writing objects. */
export async function hashFiles(
	files: ReadonlyMap<string, Uint8Array>,
): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	for (const [path, bytes] of files)
		result.set(path, (await git.hashBlob({ object: bytes })).oid);
	return result;
}

export async function commitTree(
	access: ObjectAccess,
	oid: string,
): Promise<string> {
	return (await git.readCommit({ ...access, oid })).commit.tree;
}

/** Every leaf of a tree by path. Symbolic links and submodules keep their modes. */
export async function readTreeFiles(
	access: ObjectAccess,
	tree: string,
): Promise<Map<string, TreeFile>> {
	const result = new Map<string, TreeFile>();
	if (tree === EMPTY_TREE) return result;
	async function walk(oid: string, prefix: string) {
		const { tree: entries } = await git.readTree({ ...access, oid });
		for (const entry of entries) {
			const path = prefix === '' ? entry.path : `${prefix}/${entry.path}`;
			if (entry.type === 'tree') await walk(entry.oid, path);
			else result.set(path, { oid: entry.oid, mode: entry.mode });
		}
	}
	await walk(tree, '');
	return result;
}

export async function readBlob(
	access: ObjectAccess,
	oid: string,
): Promise<Uint8Array> {
	return (await git.readBlob({ ...access, oid })).blob;
}

/** Leaf-path differences between two flattened trees, sorted by path. */
export function diffFileMaps(
	before: ReadonlyMap<string, { readonly oid: string }>,
	after: ReadonlyMap<string, { readonly oid: string } | string>,
): PathChange[] {
	const changes: PathChange[] = [];
	const oidOf = (value: { readonly oid: string } | string) =>
		typeof value === 'string' ? value : value.oid;
	for (const [path, value] of after) {
		const previous = before.get(path);
		if (previous === undefined) changes.push({ path, kind: 'add' });
		else if (previous.oid !== oidOf(value))
			changes.push({ path, kind: 'modify' });
	}
	for (const path of before.keys())
		if (!after.has(path)) changes.push({ path, kind: 'delete' });
	return changes.sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
}

export async function writeCommitObject(
	access: ObjectAccess,
	{
		tree,
		parents,
		message,
		author,
	}: {
		tree: string;
		parents: readonly string[];
		message: string;
		author: Author;
	},
): Promise<string> {
	const now = new Date();
	const signature = {
		name: author.name,
		email: author.email,
		timestamp: Math.floor(now.getTime() / 1000),
		timezoneOffset: now.getTimezoneOffset(),
	};
	return git.writeCommit({
		...access,
		commit: {
			tree,
			parent: [...parents],
			author: signature,
			committer: signature,
			message: message.endsWith('\n') ? message : `${message}\n`,
		},
	});
}

export async function isAncestor(
	access: ObjectAccess,
	ancestor: string,
	descendant: string,
): Promise<boolean> {
	if (ancestor === descendant) return true;
	return git.isDescendent({ ...access, oid: descendant, ancestor, depth: -1 });
}

/** Commits reachable from `from` that are not reachable from `exclude`, bounded. */
export async function countOnly(
	access: ObjectAccess,
	from: string | undefined,
	exclude: string | undefined,
	limit = 10_000,
): Promise<number> {
	if (from === undefined) return 0;
	const excluded = new Set<string>();
	if (exclude !== undefined) {
		const queue = [exclude];
		while (queue.length > 0 && excluded.size < limit) {
			const oid = queue.pop()!;
			if (excluded.has(oid)) continue;
			excluded.add(oid);
			try {
				queue.push(...(await git.readCommit({ ...access, oid })).commit.parent);
			} catch {
				// Missing history beyond a shallow boundary ends the walk.
			}
		}
	}
	const seen = new Set<string>();
	const queue = [from];
	while (queue.length > 0 && seen.size < limit) {
		const oid = queue.pop()!;
		if (seen.has(oid) || excluded.has(oid)) continue;
		seen.add(oid);
		try {
			queue.push(...(await git.readCommit({ ...access, oid })).commit.parent);
		} catch {
			// As above.
		}
	}
	return seen.size;
}

export async function logCommits(
	access: ObjectAccess,
	ref: string,
	depth: number,
): Promise<CommitSummary[]> {
	const entries = await git.log({ ...access, ref, depth });
	return entries.map((entry) => ({
		oid: entry.oid,
		parents: entry.commit.parent,
		message: entry.commit.message,
		author: {
			name: entry.commit.author.name,
			email: entry.commit.author.email,
			timestamp: entry.commit.author.timestamp,
		},
	}));
}
