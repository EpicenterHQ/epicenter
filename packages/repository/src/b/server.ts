/**
 * Design B's server, collapsed, in memory: live history. Every applied write
 * is a live commit `{ id, parents, author, time }` whose id hashes its parent
 * and content, so a position never repeats. `main` only moves forward: a
 * commit whose parent is `main` fast-forwards it; otherwise a `merge`-mode
 * commit is merged by the server with the Epicenter merge (base: the
 * parent's text, current: `main`'s text now) into a merge commit with two
 * parents, and a `fast-forward`-mode commit is refused. There is no note
 * identity: a stale edit merges into whatever is at the path, visibly.
 *
 * Resending a commit is answered with its recorded outcome. A flush turns
 * the live commits since the last flush into one snapshot commit with
 * trailers; live commits and outcomes are kept one flush longer, then
 * pruned, and a position or parent older than that is caught up by a full
 * snapshot.
 *
 * Rules the collapsed design does not state are marked `RULE:`.
 */
import { createHash } from 'node:crypto';
import { gitBlobHash } from '../hash.js';
import { breaksParsing } from '../markdown.js';
import { merge, withMarkers } from '../merge.js';

// ============================================================================
// Protocol
// ============================================================================

export type Author = { user: string; device: string };

export type CommitFile = {
	path: string;
	/** The file's new text, or null to delete it. */
	text: string | null;
};

/** A live commit on the wire. `id` is the SHA-1 of the canonical form of the rest. */
export type LiveCommit = {
	id: string;
	parent: string;
	mode: 'fast-forward' | 'merge';
	author: Author;
	time: string;
	files: CommitFile[];
};

/** The canonical form a commit id hashes, in a fixed order. */
export function commitId(commit: Omit<LiveCommit, 'id'>) {
	const files = commit.files.map((f) => [f.path, f.text]);
	return gitBlobHash(JSON.stringify([commit.parent, commit.mode, commit.author.user, commit.author.device, commit.time, files]));
}

export type FileState = { path: string; text: string | null; hash: string | null };

/** A body or field both sides changed, who was on each side, and the live commit that brought the incoming side. */
export type Overlap = { path: string; unit: string; current: Author; incoming: Author; commit: string };

export type PushAnswer =
	/**
	 * The commit is in `main`: fast-forwarded (`main` is the commit) or merged
	 * (`main` is the merge commit). `files` are `main`'s texts for every path
	 * changed since the commit's parent and every path it touched, so the
	 * device can stand on `main` at once.
	 */
	| {
			kind: 'applied' | 'merged';
			main: string;
			/** The commits on `main` after the commit's parent, so the device knows those notifications are old. */
			commits: string[];
			files: FileState[];
			/** Paths this commit edited that had been deleted: the edit brought them back. */
			restored: string[];
			/** Paths this commit deleted that had been edited since: the edit kept them. */
			kept: string[];
			overlaps: Overlap[];
	  }
	/** `main` moved and the commit asked to fast-forward, or a file would stop parsing. Nothing changed. */
	| { kind: 'refused'; reason: string; main: string; files: FileState[] }
	/** The commit is in a flush whose live outcome was pruned; its message's trailers say what happened. */
	| { kind: 'flushed'; flush: string; message: string }
	/** RULE: the commit's parent was pruned: catch up (a full snapshot), merge the work on top here, and commit again. */
	| { kind: 'unknown-parent' }
	| { kind: 'precondition-required' }
	| { kind: 'invalid'; reason: string };

/** A notification: the new commit, its parents, and the paths changed since its first parent, with hashes. No texts. */
export type Event = { commit: string; parents: string[]; files: { path: string; hash: string | null }[] };

export type CatchUp = {
	main: string;
	/** Every file, because the server no longer knows the position. */
	full: boolean;
	/** Paths changed since the position, with hashes. */
	files: { path: string; hash: string | null }[];
	/** The commits walked, so the device knows those notifications are old. */
	commits: string[];
	/** Live commits walked to find `files`, for the benchmark. */
	walked: number;
};

/** One commit on `main`, for audits: what each path was and became. */
export type Committed = {
	id: string;
	parents: string[];
	author: Author;
	files: { path: string; before: string | null; after: string | null }[];
};

type Stored = {
	id: string;
	parents: string[];
	author: Author;
	time: string;
	tree: string;
	changes: Set<string>;
	overlaps: Overlap[];
};

// ============================================================================
// Trees: Git tree objects, content-addressed, so every commit's snapshot stays readable
// ============================================================================

type Entry = { tree: boolean; hash: string };

function createTreeStore() {
	const nodes = new Map<string, Map<string, Entry>>();
	const store = (entries: Map<string, Entry>) => {
		// Git sorts tree entries by name, a subtree as if its name ended in '/'.
		const sorted = [...entries].sort(([a, x], [b, y]) => {
			const ka = x.tree ? `${a}/` : a;
			const kb = y.tree ? `${b}/` : b;
			return ka < kb ? -1 : ka > kb ? 1 : 0;
		});
		const parts = sorted.map(([name, entry]) =>
			Buffer.concat([Buffer.from(`${entry.tree ? '40000' : '100644'} ${name}\0`), Buffer.from(entry.hash, 'hex')]),
		);
		const body = Buffer.concat(parts);
		const hash = createHash('sha1').update(`tree ${body.length}\0`).update(body).digest('hex');
		nodes.set(hash, entries);
		return hash;
	};
	const empty = store(new Map());

	/** The tree with each path set to a blob hash, or removed for null. */
	function update(tree: string, changes: [string[], string | null][]): string {
		const entries = new Map(nodes.get(tree));
		const below = new Map<string, [string[], string | null][]>();
		for (const [segments, hash] of changes) {
			const [name = '', ...rest] = segments;
			if (rest.length === 0) {
				if (hash === null) entries.delete(name);
				else entries.set(name, { tree: false, hash });
				continue;
			}
			below.set(name, [...(below.get(name) ?? []), [rest, hash]]);
		}
		for (const [name, sub] of below) {
			const child = entries.get(name);
			const next = update(child?.tree ? child.hash : empty, sub);
			if (nodes.get(next)?.size === 0) entries.delete(name);
			else entries.set(name, { tree: true, hash: next });
		}
		return store(entries);
	}

	/** The blob hash at a path in a tree, or null. */
	function read(tree: string, path: string): string | null {
		let at = tree;
		const segments = path.split('/');
		for (const [i, name] of segments.entries()) {
			const entry = nodes.get(at)?.get(name);
			if (entry === undefined) return null;
			if (i === segments.length - 1) return entry.tree ? null : entry.hash;
			if (!entry.tree) return null;
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
				if (x?.hash === y?.hash && x?.tree === y?.tree) continue;
				const path = prefix + name;
				if (x?.tree || y?.tree) walk(x?.tree ? x.hash : empty, y?.tree ? y.hash : empty, `${path}/`);
				if ((x !== undefined && !x.tree) || (y !== undefined && !y.tree)) out.push(path);
			}
		};
		walk(from, to, '');
		return out;
	}

	return { empty, update, read, diff };
}

// ============================================================================
// The server
// ============================================================================

const SERVER: Author = { user: 'epicenter', device: 'server' };

export function createServer({ now = () => 0, onCommit }: { now?: () => number; onCommit?: (committed: Committed) => void } = {}) {
	const trees = createTreeStore();
	/** Every text ever held, by hash (Git's object store). */
	const blobs = new Map<string, string>();
	/** Live commits kept: those on `main` since the flush before last, and the devices' commits they merged. */
	const commits = new Map<string, Stored>();
	/** `main`'s first-parent chain, by absolute place; places below `offset` were pruned. */
	let chain: string[] = [];
	let offset = 0;
	const place = new Map<string, number>();
	const outcomes = new Map<string, PushAnswer>();
	const listeners = new Set<(event: Event) => void>();
	/** Who last changed each path on `main`, for overlap trailers and conflict labels. */
	const lastAuthor = new Map<string, Author>();
	const flushes: { id: string; tree: string; message: string; through: number }[] = [];
	/** RULE: every live commit id a flush took in, kept after its commit is pruned, so a resend is told `flushed`. */
	const flushedInto = new Map<string, string>();
	let liveBytes = 0;
	let made = 0;
	const time = () => new Date(Date.UTC(2026, 9, 28) + now()).toISOString();
	const at = (index: number) => commits.get(chain[index - offset] as string) as Stored;

	const rootTime = time();
	const root: Stored = {
		id: commitId({ parent: '', mode: 'merge', author: SERVER, time: rootTime, files: [] }),
		parents: [],
		author: SERVER,
		time: rootTime,
		tree: trees.empty,
		changes: new Set(),
		overlaps: [],
	};
	commits.set(root.id, root);
	chain.push(root.id);
	place.set(root.id, 0);

	const top = () => offset + chain.length - 1;
	const main = () => at(top());
	const textIn = (tree: string, path: string) => {
		const hash = trees.read(tree, path);
		return hash === null ? null : (blobs.get(hash) ?? null);
	};
	const state = (path: string): FileState => {
		const hash = trees.read(main().tree, path);
		return { path, text: hash === null ? null : (blobs.get(hash) ?? null), hash };
	};

	/** Paths changed on `main` after place `from`, the commits walked, and how many. */
	function changedSince(from: number) {
		const paths = new Set<string>();
		for (let i = from + 1; i <= top(); i++) for (const path of at(i).changes) paths.add(path);
		return { paths, ids: chain.slice(from + 1 - offset), walked: top() - from };
	}

	/** Put a commit on `main`: its snapshot and its notification. */
	function advance(stored: Omit<Stored, 'tree' | 'changes'>, files: CommitFile[]) {
		const before = main();
		const tree = trees.update(
			before.tree,
			files.map((f) => {
				const hash = f.text === null ? null : gitBlobHash(f.text);
				if (hash !== null && f.text !== null) blobs.set(hash, f.text);
				return [f.path.split('/'), hash];
			}),
		);
		const changes = new Set(files.filter((f) => textIn(before.tree, f.path) !== f.text).map((f) => f.path));
		const commit: Stored = { ...stored, tree, changes };
		onCommit?.({
			id: commit.id,
			parents: commit.parents,
			author: commit.author,
			files: files.map((f) => ({ path: f.path, before: textIn(before.tree, f.path), after: f.text })),
		});
		commits.set(commit.id, commit);
		place.set(commit.id, top() + 1);
		chain.push(commit.id);
		made++;
		for (const path of changes) {
			lastAuthor.set(path, stored.author);
			liveBytes += path.length + (textIn(tree, path)?.length ?? 0);
		}
		liveBytes += 200;
		const event: Event = { commit: commit.id, parents: commit.parents, files: [...changes].map((path) => ({ path, hash: trees.read(tree, path) })) };
		for (const listener of listeners) listener(event);
	}

	function push(commit: LiveCommit): PushAnswer {
		if (commit.parent === undefined) return { kind: 'precondition-required' };
		const recorded = outcomes.get(commit.id);
		if (recorded !== undefined) return recorded;
		const flush = flushedInto.get(commit.id);
		if (flush !== undefined) return { kind: 'flushed', flush, message: flushes.find((f) => f.id === flush)?.message ?? '' };
		if (commitId(commit) !== commit.id) return { kind: 'invalid', reason: 'the id is not the hash of the commit' };
		const from = place.get(commit.parent);
		if (from === undefined || from < offset) return { kind: 'unknown-parent' };
		const paths = new Set(commit.files.map((f) => f.path));
		if (paths.size !== commit.files.length) return { kind: 'invalid', reason: 'a path is named twice' };
		const head = main();
		const current = (path: string) => textIn(head.tree, path);
		const refuse = (reason: string): PushAnswer => ({ kind: 'refused', reason, main: head.id, files: commit.files.map((f) => state(f.path)) });

		const forward = commit.parent === head.id;
		if (commit.mode === 'fast-forward' && !forward) return refuse('main moved');
		const breaks = commit.files.some((f) => breaksParsing(f.path, current(f.path), f.text));
		if (forward && !breaks) {
			advance({ id: commit.id, parents: [commit.parent], author: commit.author, time: commit.time, overlaps: [] }, commit.files);
			return record(commit, { kind: 'applied', main: commit.id, commits: [], files: [], restored: [], kept: [], overlaps: [] }, from);
		}
		if (commit.mode === 'fast-forward') return refuse('the frontmatter would no longer parse');

		// Merge where the commit's history and main's meet: base is the parent's text, current is main's now.
		const parentTree = at(from).tree;
		const out: CommitFile[] = [];
		const answer = { restored: [] as string[], kept: [] as string[], overlaps: [] as Overlap[] };
		for (const file of commit.files) {
			const base = textIn(parentTree, file.path);
			const ours = current(file.path);
			const result = merge(base, ours, file.text);
			const who = lastAuthor.get(file.path) ?? SERVER;
			let text = withMarkers(result, { current: `main (${who.user}/${who.device})`, incoming: `${commit.author.user}/${commit.author.device}` });
			// RULE: a merged text that would stop a parsing note from parsing keeps main's text; the device keeps its own.
			if (breaksParsing(file.path, ours, text)) text = ours;
			for (const overlap of result.overlaps) {
				const unit = overlap.unit === 'field' ? `field ${overlap.key}` : overlap.unit === 'file' ? `file ${overlap.clash}` : overlap.unit;
				answer.overlaps.push({ path: file.path, unit, current: who, incoming: commit.author, commit: commit.id });
			}
			if (ours === null && base !== null && text !== null) answer.restored.push(file.path);
			if (file.text === null && text !== null) answer.kept.push(file.path);
			out.push({ path: file.path, text });
		}
		// The device's commit stays a real commit: the merge's second parent.
		for (const f of commit.files) if (f.text !== null) blobs.set(gitBlobHash(f.text), f.text);
		commits.set(commit.id, {
			id: commit.id,
			parents: [commit.parent],
			author: commit.author,
			time: commit.time,
			tree: trees.update(parentTree, commit.files.map((f) => [f.path.split('/'), f.text === null ? null : gitBlobHash(f.text)])),
			changes: new Set(),
			overlaps: [],
		});
		const mergeTime = time();
		const id = commitId({ parent: `${head.id} ${commit.id}`, mode: 'merge', author: SERVER, time: mergeTime, files: out });
		advance({ id, parents: [head.id, commit.id], author: commit.author, time: mergeTime, overlaps: answer.overlaps }, out);
		return record(commit, { kind: 'merged', main: id, commits: [], files: [], ...answer }, from);
	}

	/** Fill an answer's files (everything changed since the commit's parent, and what it touched) and keep it for a resend. */
	function record(commit: LiveCommit, answer: Extract<PushAnswer, { kind: 'applied' | 'merged' }>, from: number): PushAnswer {
		const { paths, ids } = changedSince(from);
		for (const f of commit.files) paths.add(f.path);
		const full = { ...answer, commits: ids, files: [...paths].sort().map(state) };
		outcomes.set(commit.id, full);
		return full;
	}

	return {
		/** The current `main`. */
		main: () => main().id,
		read: (path: string) => textIn(main().tree, path),
		/** Every path and text on `main`, sorted. */
		snapshot: () =>
			new Map(
				trees
					.diff(trees.empty, main().tree)
					.sort()
					.map((path) => [path, textIn(main().tree, path) as string]),
			),
		/** Take a live commit: fast-forward `main`, merge it in, or refuse it; a resend gets the recorded outcome. */
		push,
		/**
		 * What changed on `main` since `from`, by walking history, plus `paths`
		 * the device names. A position the server no longer keeps (pruned, or
		 * none) gets every file.
		 */
		catchUp({ from, paths = [] }: { from: string | null; paths?: string[] }): CatchUp {
			const index = from === null ? undefined : place.get(from);
			const head = main();
			if (index === undefined || index < offset) {
				// The paths the device named come too, absent or not, so it learns a named path is gone.
				const all = [...new Set([...trees.diff(trees.empty, head.tree), ...paths])].sort();
				return { main: head.id, full: true, walked: 0, commits: [], files: all.map((path) => ({ path, hash: trees.read(head.tree, path) })) };
			}
			const { paths: changed, ids, walked } = changedSince(index);
			for (const path of paths) changed.add(path);
			return { main: head.id, full: false, walked, commits: ids, files: [...changed].sort().map((path) => ({ path, hash: trees.read(head.tree, path) })) };
		},
		/** Texts by hash: a content-addressed read, never stale. */
		fetch: (hashes: string[]) => Object.fromEntries(hashes.flatMap((hash) => (blobs.has(hash) ? [[hash, blobs.get(hash) as string]] : []))),
		subscribe(listener: (event: Event) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/**
		 * Turn the live commits since the last flush into one snapshot commit
		 * with the design's message, then prune the live commits (and their
		 * outcomes) that the flush before this one took in.
		 */
		flush() {
			const last = flushes.at(-1);
			const from = (last?.through ?? 0) + 1;
			if (from > top()) return null;
			const range: Stored[] = [];
			for (let i = from; i <= top(); i++) range.push(at(i));
			const head = main();
			const paths = trees.diff(last?.tree ?? trees.empty, head.tree).sort();
			const counts = new Map<string, number>();
			const taken = new Set<string>();
			for (const commit of range) {
				counts.set(commit.author.user, (counts.get(commit.author.user) ?? 0) + 1);
				taken.add(commit.id);
				for (const p of commit.parents.slice(1)) taken.add(p);
			}
			const short = (id: string) => id.slice(0, 7);
			const subject = paths.length === 1 ? `Edit ${paths[0]}` : `Edit ${paths[0] ?? 'nothing'} and ${paths.length - 1} others`;
			const trailers = [
				`Epicenter-Live: ${short(range[0]?.id ?? '')}..${short(head.id)} (${range.length} commits)`,
				...range.flatMap((c) =>
					c.overlaps.map(
						(o) => `Epicenter-Overlap: ${o.path} ${o.unit} (${o.current.user}/${o.current.device}, ${o.incoming.user}/${o.incoming.device}) in ${short(o.commit)}`,
					),
				),
				...[...counts.keys()].sort().map((user) => `Co-authored-by: ${user[0]?.toUpperCase()}${user.slice(1)} <${user}@example.com>`),
			];
			const author = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'epicenter';
			const message = `${subject}\n\n${paths.join('\n')}\n\n${trailers.join('\n')}\n`;
			const id = createHash('sha1').update(`${last?.id ?? ''}\n${head.tree}\n${author}\n${message}`).digest('hex');
			flushes.push({ id, tree: head.tree, message, through: top() });
			for (const live of taken) flushedInto.set(live, id);
			// RULE: live commits outlive their flush by one more flush, so positions and resends from just before it still resolve.
			const prune = last?.through;
			if (prune !== undefined && prune > offset) {
				for (let i = offset; i < prune; i++) {
					const commit = at(i);
					for (const id_ of [commit.id, ...commit.parents.slice(1)]) {
						commits.delete(id_);
						outcomes.delete(id_);
					}
				}
				chain = chain.slice(prune - offset);
				offset = prune;
			}
			return { id, author, message };
		},
		/** Live commits ever made and kept, their approximate bytes, and flushes, for the benchmark. */
		history: () => ({ commits: made, kept: chain.length, bytes: liveBytes, flushes: flushes.length }),
	};
}

export type Server = ReturnType<typeof createServer>;
