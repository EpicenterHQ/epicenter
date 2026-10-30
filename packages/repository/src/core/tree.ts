/**
 * Trees: Git tree objects, content-addressed, so every commit's snapshot
 * stays readable and two snapshots compare by walking only what differs.
 *
 * A tree store keeps each tree it built by its Git tree id (in memory, or
 * in the nodes a host gives it). A
 * path's segments are tree entries; a file is a blob id. Setting a path
 * builds new trees along it and shares every untouched subtree, and a
 * subtree left empty is removed, as Git has no empty trees.
 *
 * A name is a file or a folder, never both: a change set that would put a
 * file where a folder still has files, or a file beneath a file, is a
 * `collision`, which its caller refuses (only a person can fix it, by
 * renaming one). `update` throws on one rather than drop either side.
 */
import { gitTreeHash, type TreeEntry as Entry } from './hash.js';

/** Why a change set cannot be one tree, by the path of the file it would write: over a folder, or beneath a file. */
export const COLLISIONS = {
	'is-a-folder': 'a folder already has this name',
	'under-a-file': 'a file already has this name',
} as const;
export type Collision = { path: string; code: keyof typeof COLLISIONS };


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

	/**
	 * The first file `changes` (paths as segments, null deletes) would write
	 * where the result holds a folder with files, or beneath a file, or null
	 * when the result is one tree. Reads only the entries along written paths.
	 */
	function collision(tree: string, changes: [string[], string | null][]): Collision | null {
		const changed = new Map(changes.map(([segments, hash]) => [segments.join('/'), hash]));
		const child = (entry: Entry | undefined, name: string) => (entry?.kind === 'tree' ? nodes.get(entry.hash)?.get(name) : undefined);
		for (const [path, hash] of changed) {
			if (hash === null) continue;
			const segments = path.split('/');
			let at: Entry | undefined = { kind: 'tree', hash: tree };
			for (let i = 0; i < segments.length - 1; i++) {
				at = child(at, segments[i] as string);
				const named = changed.get(segments.slice(0, i + 1).join('/'));
				if (named === undefined ? at?.kind === 'blob' : named !== null) return { path, code: 'under-a-file' };
			}
			const here = child(at, segments.at(-1) as string);
			// A folder at the name collides unless the change set deletes every file in it; a write into it is caught from its own side.
			if (here?.kind === 'tree' && diff(empty, here.hash).some((inside) => changed.get(`${path}/${inside}`) !== null)) return { path, code: 'is-a-folder' };
		}
		return null;
	}

	/** The tree with each path (as segments) set to a blob id, or removed for null; throws on a `collision`, which its caller must refuse first. */
	function update(tree: string, changes: [string[], string | null][]): string {
		const found = collision(tree, changes);
		if (found !== null) throw new Error(`${found.path}: ${COLLISIONS[found.code]}`);
		return build(tree, changes);
	}

	function build(tree: string, changes: [string[], string | null][]): string {
		const entries = new Map(nodes.get(tree));
		const own = new Map<string, string | null>();
		const below = new Map<string, [string[], string | null][]>();
		for (const [segments, hash] of changes) {
			const [name = '', ...rest] = segments;
			if (rest.length === 0) own.set(name, hash);
			else below.set(name, [...(below.get(name) ?? []), [rest, hash]]);
		}
		for (const name of new Set([...own.keys(), ...below.keys()])) {
			const write = own.get(name);
			// A delete names a file: a folder at that name is not it, and keeps its files.
			if (write === null && entries.get(name)?.kind === 'blob') entries.delete(name);
			const child = entries.get(name);
			const sub = below.get(name);
			// Below a file there is nothing to delete; `collision` refused any write there.
			if (sub !== undefined && child?.kind !== 'blob') {
				const next = build(child?.kind === 'tree' ? child.hash : empty, sub);
				if (nodes.get(next)?.size === 0) entries.delete(name);
				else entries.set(name, { kind: 'tree', hash: next });
			}
			// A file's write comes after its folder emptied, so one change set may turn either into the other.
			if (typeof write === 'string') entries.set(name, { kind: 'blob', hash: write });
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

	/** The trees `to` holds that `from` does not, along what differs (`to` itself included unless equal): what Git lacks of `to` when it has `from`. */
	function added(from: string, to: string) {
		const out: string[] = [];
		const walk = (a: string | undefined, b: string) => {
			if (a === b) return;
			out.push(b);
			const left = a === undefined ? undefined : nodes.get(a);
			for (const [name, entry] of nodes.get(b) ?? []) {
				if (entry.kind !== 'tree') continue;
				const before = left?.get(name);
				walk(before?.kind === 'tree' ? before.hash : undefined, entry.hash);
			}
		};
		walk(from, to);
		return out;
	}

	return {
		/** The empty tree's id. */
		empty,
		update,
		collision,
		read,
		diff,
		added,
		/** A tree's entries, by name, or undefined when the store does not hold it. */
		entries: (tree: string) => nodes.get(tree),
	};
}
export type TreeStore = ReturnType<typeof createTreeStore>;
