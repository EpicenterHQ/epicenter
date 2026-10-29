/**
 * Trees: Git tree objects, content-addressed, so every commit's snapshot
 * stays readable and two snapshots compare by walking only what differs.
 *
 * A tree store keeps each tree it built by its Git tree id (in memory, or
 * in the nodes a host gives it). A
 * path's segments are tree entries; a file is a blob id. Setting a path
 * builds new trees along it and shares every untouched subtree, and a
 * subtree left empty is removed, as Git has no empty trees.
 */
import { gitTreeHash, type TreeEntry as Entry } from './hash.js';


/** Where a tree store keeps its trees, by id: a `Map` in memory, or a host's table. */
export type TreeNodes = {
	get(hash: string): Map<string, Entry> | undefined;
	set(hash: string, entries: Map<string, Entry>): void;
};

export function createTreeStore(nodes: TreeNodes = new Map<string, Map<string, Entry>>()) {
	const store = (entries: Map<string, Entry>) => {
		const hash = gitTreeHash([...entries]);
		nodes.set(hash, entries);
		return hash;
	};
	const empty = store(new Map());

	/** The tree with each path (as segments) set to a blob id, or removed for null. */
	function update(tree: string, changes: [string[], string | null][]): string {
		const entries = new Map(nodes.get(tree));
		const below = new Map<string, [string[], string | null][]>();
		for (const [segments, hash] of changes) {
			const [name = '', ...rest] = segments;
			if (rest.length === 0) {
				if (hash === null) entries.delete(name);
				else entries.set(name, { kind: 'blob', hash });
				continue;
			}
			below.set(name, [...(below.get(name) ?? []), [rest, hash]]);
		}
		for (const [name, sub] of below) {
			const child = entries.get(name);
			const next = update(child?.kind === 'tree' ? child.hash : empty, sub);
			if (nodes.get(next)?.size === 0) entries.delete(name);
			else entries.set(name, { kind: 'tree', hash: next });
		}
		return store(entries);
	}

	/** The blob id at a path in a tree, or null. */
	function read(tree: string, path: string): string | null {
		let at = tree;
		const segments = path.split('/');
		for (const [i, name] of segments.entries()) {
			const entry = nodes.get(at)?.get(name);
			if (entry === undefined) return null;
			if (i === segments.length - 1) return entry.kind === 'tree' ? null : entry.hash;
			if (entry.kind !== 'tree') return null;
			at = entry.hash;
		}
		return null;
	}

	/** Paths whose blob differs between two trees. */
	function diff(from: string, to: string) {
		const out: string[] = [];
		const walk = (a: string, b: string, prefix: string) => {
			if (a === b) return;
			const left = nodes.get(a) ?? new Map<string, Entry>();
			const right = nodes.get(b) ?? new Map<string, Entry>();
			for (const name of new Set([...left.keys(), ...right.keys()])) {
				const x = left.get(name);
				const y = right.get(name);
				if (x?.hash === y?.hash && x?.kind === y?.kind) continue;
				const path = prefix + name;
				if (x?.kind === 'tree' || y?.kind === 'tree')
					walk(x?.kind === 'tree' ? x.hash : empty, y?.kind === 'tree' ? y.hash : empty, `${path}/`);
				if (x?.kind === 'blob' || y?.kind === 'blob') out.push(path);
			}
		};
		walk(from, to, '');
		return out;
	}

	return {
		/** The empty tree's id. */
		empty,
		update,
		read,
		diff,
	};
}
export type TreeStore = ReturnType<typeof createTreeStore>;
