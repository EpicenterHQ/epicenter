/**
 * A `GitObjects` in memory, with real Git object ids, for tests and the
 * simulated network: the same ids the Bun Git store writes, so a flush
 * planned against one is checked against the other by the same rules.
 */
import { gitBlobHash, gitCommitHash, gitTreeHash, type TreeEntry } from '../core/hash.js';
import type { CommitInfo, GitObjects, Tree } from './git-store.js';

type Stored =
	| { kind: 'blob'; bytes: Uint8Array }
	| { kind: 'tree'; entries: Map<string, TreeEntry> }
	| { kind: 'commit'; info: CommitInfo };

type Level = Map<string, { mode: string; oid: string } | Level>;

export function createMemoryGitStore() {
	const objects = new Map<string, Stored>();
	const refs = new Map<string, string>();

	function writeLevel(level: Level): string {
		const entries = new Map<string, TreeEntry>();
		for (const [name, entry] of level)
			entries.set(name, entry instanceof Map ? { kind: 'tree', hash: writeLevel(entry) } : { kind: 'blob', hash: entry.oid, mode: entry.mode });
		const oid = gitTreeHash([...entries]);
		objects.set(oid, { kind: 'tree', entries });
		return oid;
	}

	function flatten(oid: string, prefix: string, out: Tree) {
		const tree = objects.get(oid);
		if (tree?.kind !== 'tree') throw new Error(`no tree ${oid}`);
		for (const [name, entry] of tree.entries) {
			if (entry.kind === 'tree') flatten(entry.hash, `${prefix}${name}/`, out);
			else out.set(`${prefix}${name}`, { mode: entry.mode ?? '100644', oid: entry.hash });
		}
	}

	const store = {
		async readRef(name) {
			return refs.get(name) ?? null;
		},
		async readCommit(oid) {
			const found = objects.get(oid);
			return found?.kind === 'commit' ? found.info : null;
		},
		async readTree(oid) {
			const out: Tree = new Map();
			flatten(oid, '', out);
			return out;
		},
		async readBlob(oid) {
			const found = objects.get(oid);
			return found?.kind === 'blob' ? found.bytes : null;
		},
		async writeBlob(bytes) {
			const oid = gitBlobHash(bytes);
			objects.set(oid, { kind: 'blob', bytes });
			return oid;
		},
		async writeTree(tree) {
			const root: Level = new Map();
			for (const [path, entry] of tree) {
				const parts = path.split('/');
				const name = parts.pop() ?? path;
				let level = root;
				for (const part of parts) {
					let next = level.get(part);
					if (!(next instanceof Map)) {
						next = new Map();
						level.set(part, next);
					}
					level = next;
				}
				level.set(name, entry);
			}
			return writeLevel(root);
		},
		async writeCommit({ tree, parents, message, author, committer = author, at }) {
			const seconds = Math.floor(at.getTime() / 1000);
			const oid = gitCommitHash({ tree, parents, message, author: { ...author, at: seconds }, committer: { ...committer, at: seconds } });
			objects.set(oid, { kind: 'commit', info: { tree, parents, message } });
			return oid;
		},
		async updateRef(name, next, expected) {
			if ((refs.get(name) ?? null) !== expected) return false;
			refs.set(name, next);
			return true;
		},
		async deleteRef(name, expected) {
			const current = refs.get(name);
			if (current === undefined) return true;
			if (current !== expected) return false;
			refs.delete(name);
			return true;
		},
	} satisfies GitObjects;
	return {
		...store,
		/** Every ref and where it points, for tests. */
		refs: () => new Map(refs),
	};
}
export type MemoryGitStore = ReturnType<typeof createMemoryGitStore>;
