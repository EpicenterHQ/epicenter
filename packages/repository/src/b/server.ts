/**
 * Design B's server, revised, in memory: live history. Every applied write
 * is a live commit `{ id, parents, author, time }` whose id hashes its parent
 * and content, so a position never repeats. `main` only moves forward: a
 * commit whose parent is `main` fast-forwards it; otherwise a `merge`-mode
 * commit is merged by the server with the Epicenter merge into a merge
 * commit with two parents, and a `fast-forward`-mode commit is refused.
 *
 * History answers ordering (a device names the commit it is based on) and
 * identity (a path deleted and created again between a commit's base and
 * `main` holds another note, so the edit becomes a sibling). Resending a
 * commit is answered with its recorded outcome. A flush turns the live
 * commits since the last flush into one snapshot commit with trailers.
 *
 * Rules this server needed that the revised design does not state are
 * marked `RULE:` and listed in the report.
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
	/**
	 * RULE: the commit this file's text was made on, when not the commit's
	 * parent: a device that kept unsent work through a remote delete names the
	 * commit before the delete, so the server merges from there and can tell a
	 * restore from a replacement.
	 */
	from?: string;
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

/** The canonical form a commit id hashes: fixed order, `from` only when present. */
export function commitId(commit: Omit<LiveCommit, 'id'>) {
	const files = commit.files.map((f) => (f.from === undefined ? [f.path, f.text] : [f.path, f.text, f.from]));
	return gitBlobHash(JSON.stringify([commit.parent, commit.mode, commit.author.user, commit.author.device, commit.time, files]));
}

export type FileState = { path: string; text: string | null; hash: string | null; replaced?: true };

/** A body or field both sides changed, and who was on each side. */
export type Overlap = { path: string; unit: string; current: Author; incoming: Author };

export type PushAnswer =
	/**
	 * The commit is in `main`: fast-forwarded (`main` is the commit) or merged
	 * (`main` is the merge commit). `files` are `main`'s texts for every path
	 * changed since the commit's parent, every path it touched, and its
	 * siblings, so the device can stand on `main` at once.
	 */
	| {
			kind: 'applied' | 'merged';
			main: string;
			/** RULE: the commits on `main` after the commit's parent, so the device knows those notifications are old. */
			commits: string[];
			/** Each marked `replaced` when history since the commit's parent says the path holds another note now. */
			files: FileState[];
			siblings: { from: string; to: string }[];
			/** Paths this commit edited that had been deleted: the edit brought them back. */
			restored: string[];
			/** Paths this commit deleted that had been edited since: the edit kept them. */
			kept: string[];
			overlaps: Overlap[];
	  }
	/** `main` moved and the commit asked to fast-forward, or a file would stop parsing. Nothing changed. */
	| { kind: 'refused'; reason: string; main: string; files: FileState[] }
	/** RULE: the commit is in a flush whose live outcome is gone; its message's trailers say what happened. */
	| { kind: 'flushed'; flush: string; message: string }
	| { kind: 'precondition-required' }
	| { kind: 'invalid'; reason: string };

/** A notification: the new commit, its parents, and the paths changed since its first parent, with hashes. No texts. */
export type Event = { commit: string; parents: string[]; files: { path: string; hash: string | null }[] };

export type CatchUp = {
	main: string;
	/** Every file, because the server does not know the position. */
	full: boolean;
	/** Paths changed since the position, with hashes; `replaced` when the path was deleted and holds another note now. */
	files: { path: string; hash: string | null; replaced?: true }[];
	/** The commits walked, so the device knows those notifications are old. */
	commits: string[];
	/** Live commits walked to find `files`, for the benchmark. */
	walked: number;
};

/** What a commit did at a path, for history walks. */
export type Kind = 'create' | 'edit' | 'delete' | 'restore';

/**
 * One commit on `main`, for audits: what each path was and became, and for a
 * device's change, the commit its text was made on (`from`; none for a sibling).
 */
export type Committed = {
	id: string;
	parents: string[];
	author: Author;
	files: { path: string; kind: Kind; before: string | null; after: string | null; from?: string }[];
};

type Stored = {
	id: string;
	parents: string[];
	author: Author;
	time: string;
	tree: string;
	changes: Map<string, Kind>;
	/** For each path it changed and did not delete, the commit that created the note there (a restore keeps its note's). */
	born: Map<string, string>;
	overlaps: Overlap[];
	siblings: { from: string; to: string }[];
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

export function createServer({
	now = () => 0,
	today = () => '2026-10-28',
	onCommit,
}: { now?: () => number; today?: () => string; onCommit?: (committed: Committed) => void } = {}) {
	const trees = createTreeStore();
	/** Every text ever held, by hash (Git's object store). */
	const blobs = new Map<string, string>();
	const commits = new Map<string, Stored>();
	/** `main`'s first-parent chain, oldest first, and each commit's place in it. */
	const chain: string[] = [];
	const place = new Map<string, number>();
	const outcomes = new Map<string, PushAnswer>();
	const listeners = new Set<(event: Event) => void>();
	/** Who last changed each path on `main`, for overlap trailers and conflict labels. */
	const lastAuthor = new Map<string, Author>();
	const flushes: { id: string; tree: string; message: string; through: number }[] = [];
	const flushedInto = new Map<string, string>();
	let liveBytes = 0;
	const time = () => new Date(Date.UTC(2026, 9, 28) + now()).toISOString();

	const rootTime = time();
	const root: Stored = {
		id: commitId({ parent: '', mode: 'merge', author: SERVER, time: rootTime, files: [] }),
		parents: [],
		author: SERVER,
		time: rootTime,
		tree: trees.empty,
		changes: new Map(),
		born: new Map(),
		overlaps: [],
		siblings: [],
	};
	commits.set(root.id, root);
	chain.push(root.id);
	place.set(root.id, 0);

	const main = () => commits.get(chain.at(-1) as string) as Stored;
	const textIn = (tree: string, path: string) => {
		const hash = trees.read(tree, path);
		return hash === null ? null : (blobs.get(hash) ?? null);
	};
	const state = (path: string): FileState => {
		const hash = trees.read(main().tree, path);
		return { path, text: hash === null ? null : (blobs.get(hash) ?? null), hash };
	};

	/**
	 * The note at a path at a commit on `main`, named by the commit that
	 * created it: walk back to the last change of the path.
	 */
	function bornAt(at: number, path: string): string | null {
		for (let i = at; i >= 0; i--) {
			const commit = commits.get(chain[i] as string);
			const kind = commit?.changes.get(path);
			if (kind === undefined) continue;
			return kind === 'delete' ? null : (commit?.born.get(path) ?? null);
		}
		return null;
	}

	/**
	 * RULE: identity from history is the commit that created the note. A path
	 * holds another note than at `from` when both have one and their creating
	 * commits differ: deleted and created again, or deleted and brought back
	 * by an edit of an older note.
	 */
	function replacedSince(from: number, path: string) {
		const then = bornAt(from, path);
		const now_ = bornAt(chain.length - 1, path);
		return then !== null && now_ !== null && then !== now_;
	}

	/** Paths changed on `main` after `from`, and how many commits that walked. */
	function changedSince(from: number) {
		const paths = new Set<string>();
		for (let i = from + 1; i < chain.length; i++) for (const path of commits.get(chain[i] as string)?.changes.keys() ?? []) paths.add(path);
		return { paths, walked: chain.length - 1 - from };
	}

	function siblingPath(path: string, device: string, taken: (path: string) => boolean) {
		const slash = path.lastIndexOf('/');
		const name = path.slice(slash + 1);
		const dot = name.lastIndexOf('.');
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const extension = dot > 0 ? name.slice(dot) : '';
		const prefix = `${path.slice(0, slash + 1)}${stem} (${device}, ${today()})`;
		let candidate = `${prefix}${extension}`;
		for (let n = 2; taken(candidate); n++) candidate = `${prefix} ${n}${extension}`;
		return candidate;
	}

	/** Put a commit on `main`: its snapshot, its history kinds, its notification. */
	function advance(stored: Omit<Stored, 'tree' | 'changes' | 'born'>, files: { path: string; text: string | null; kind: Kind; from?: string }[]) {
		const before = main();
		const tree = trees.update(
			before.tree,
			files.map((f) => {
				const hash = f.text === null ? null : gitBlobHash(f.text);
				if (hash !== null && f.text !== null) blobs.set(hash, f.text);
				return [f.path.split('/'), hash];
			}),
		);
		const changes = new Map(
			files.filter((f) => textIn(before.tree, f.path) !== f.text || f.kind === 'restore').map((f) => [f.path, f.kind] as const),
		);
		const born = new Map<string, string>();
		for (const f of files) {
			if (!changes.has(f.path) || f.kind === 'delete') continue;
			if (f.kind === 'create') born.set(f.path, stored.id);
			else if (f.kind === 'restore') born.set(f.path, bornAt(place.get(f.from ?? '') ?? chain.length - 1, f.path) ?? stored.id);
			else born.set(f.path, bornAt(chain.length - 1, f.path) ?? stored.id);
		}
		const commit: Stored = { ...stored, tree, changes, born };
		onCommit?.({
			id: commit.id,
			parents: commit.parents,
			author: commit.author,
			files: files.map((f) => ({ path: f.path, kind: f.kind, before: textIn(before.tree, f.path), after: f.text, ...(f.from === undefined ? {} : { from: f.from }) })),
		});
		commits.set(commit.id, commit);
		place.set(commit.id, chain.length);
		chain.push(commit.id);
		for (const path of changes.keys()) {
			lastAuthor.set(path, stored.author);
			liveBytes += path.length + (textIn(tree, path)?.length ?? 0);
		}
		liveBytes += 200;
		const event: Event = { commit: commit.id, parents: commit.parents, files: [...changes.keys()].map((path) => ({ path, hash: trees.read(tree, path) })) };
		for (const listener of listeners) listener(event);
		return commit;
	}

	const kindOf = (before: string | null, after: string | null, restored: boolean): Kind =>
		after === null ? 'delete' : before === null ? (restored ? 'restore' : 'create') : 'edit';

	function push(commit: LiveCommit): PushAnswer {
		if (commit.parent === undefined) return { kind: 'precondition-required' };
		const recorded = outcomes.get(commit.id);
		if (recorded !== undefined) return recorded;
		const flush = flushedInto.get(commit.id);
		if (flush !== undefined) return { kind: 'flushed', flush, message: flushes.find((f) => f.id === flush)?.message ?? '' };
		if (commitId(commit) !== commit.id) return { kind: 'invalid', reason: 'the id is not the hash of the commit' };
		const at = place.get(commit.parent);
		if (at === undefined) return { kind: 'invalid', reason: 'the parent is not on main' };
		const paths = new Set(commit.files.map((f) => f.path));
		if (paths.size !== commit.files.length) return { kind: 'invalid', reason: 'a path is named twice' };
		const head = main();
		const current = (path: string) => textIn(head.tree, path);
		const refuse = (reason: string): PushAnswer => ({ kind: 'refused', reason, main: head.id, files: commit.files.map((f) => state(f.path)) });

		const forward = commit.parent === head.id && commit.files.every((f) => f.from === undefined || f.from === head.id);
		if (commit.mode === 'fast-forward' && !forward) return refuse('main moved');
		const breaks = commit.files.some((f) => breaksParsing(f.path, current(f.path), f.text));
		if (forward && !breaks) {
			const files = commit.files.map((f) => ({ path: f.path, text: f.text, kind: kindOf(current(f.path), f.text, false), from: commit.parent }));
			advance({ id: commit.id, parents: [commit.parent], author: commit.author, time: commit.time, overlaps: [], siblings: [] }, files);
			return record(commit, { kind: 'applied', main: commit.id, commits: [], files: [], siblings: [], restored: [], kept: [], overlaps: [] }, at);
		}
		if (commit.mode === 'fast-forward') return refuse('the frontmatter would no longer parse');

		// Merge, where the commit's history and main's meet.
		const parentTree = commits.get(commit.parent)?.tree ?? trees.empty;
		const out: { path: string; text: string | null; kind: Kind; from?: string }[] = [];
		const answer = { siblings: [] as { from: string; to: string }[], restored: [] as string[], kept: [] as string[], overlaps: [] as Overlap[] };
		const taken = (path: string) => current(path) !== null || paths.has(path) || out.some((f) => f.path === path && f.text !== null);
		for (const file of commit.files) {
			const from = file.from === undefined ? at : (place.get(file.from) ?? at);
			const base = textIn(file.from === undefined ? parentTree : (commits.get(file.from)?.tree ?? parentTree), file.path);
			const ours = current(file.path);
			if (ours !== null && replacedSince(from, file.path)) {
				// Identity from history: the path holds another note now. The edit goes beside it.
				if (file.text !== null) {
					const to = siblingPath(file.path, commit.author.device, taken);
					out.push({ path: to, text: file.text, kind: 'create' });
					answer.siblings.push({ from: file.path, to });
				}
				continue;
			}
			const result = merge(base, ours, file.text);
			const who = lastAuthor.get(file.path) ?? SERVER;
			let text = withMarkers(result, { current: `main (${who.user}/${who.device})`, incoming: `${commit.author.user}/${commit.author.device}` });
			// RULE: a merged text that would stop a parsing note from parsing keeps main's text; the device keeps its own.
			if (breaksParsing(file.path, ours, text)) text = ours;
			for (const overlap of result.overlaps) {
				const unit = overlap.unit === 'field' ? `field ${overlap.key}` : overlap.unit === 'file' ? `file ${overlap.clash}` : overlap.unit;
				answer.overlaps.push({ path: file.path, unit, current: who, incoming: commit.author });
			}
			const restored = ours === null && base !== null && text !== null;
			if (restored) answer.restored.push(file.path);
			if (file.text === null && text !== null) answer.kept.push(file.path);
			out.push({ path: file.path, text, kind: kindOf(ours, text, restored), from: file.from ?? commit.parent });
		}
		// The device's commit stays a real commit: the merge's second parent.
		for (const f of commit.files) if (f.text !== null) blobs.set(gitBlobHash(f.text), f.text);
		commits.set(commit.id, {
			id: commit.id,
			parents: [commit.parent],
			author: commit.author,
			time: commit.time,
			tree: trees.update(parentTree, commit.files.map((f) => [f.path.split('/'), f.text === null ? null : gitBlobHash(f.text)])),
			changes: new Map(),
			born: new Map(),
			overlaps: [],
			siblings: [],
		});
		const mergeTime = time();
		const id = commitId({ parent: `${head.id} ${commit.id}`, mode: 'merge', author: SERVER, time: mergeTime, files: out.map((f) => ({ path: f.path, text: f.text })) });
		advance({ id, parents: [head.id, commit.id], author: commit.author, time: mergeTime, overlaps: answer.overlaps, siblings: answer.siblings }, out);
		return record(commit, { kind: 'merged', main: id, commits: [], files: [], ...answer }, at);
	}

	/** Fill an answer's files (everything changed since the commit's parent, what it touched, its siblings) and keep it for a resend. */
	function record(commit: LiveCommit, answer: Extract<PushAnswer, { kind: 'applied' | 'merged' }>, at: number): PushAnswer {
		const { paths } = changedSince(at);
		const touched = new Set([...commit.files.map((f) => f.path), ...answer.siblings.map((s) => s.to)]);
		for (const path of touched) paths.add(path);
		const files = [...paths].sort().map((path) => {
			const file = state(path);
			return !touched.has(path) && file.text !== null && replacedSince(at, path) ? { ...file, replaced: true as const } : file;
		});
		const full = { ...answer, commits: chain.slice(at + 1), files };
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
		 * the device names. An unknown position gets every file.
		 */
		catchUp({ from, paths = [] }: { from: string | null; paths?: { path: string; at?: string }[] }): CatchUp {
			const at = from === null ? undefined : place.get(from);
			const head = main();
			if (at === undefined) {
				const all = trees.diff(trees.empty, head.tree);
				return { main: head.id, full: true, walked: 0, commits: [], files: all.map((path) => ({ path, hash: trees.read(head.tree, path) })) };
			}
			const { paths: changed, walked } = changedSince(at);
			// RULE: a path the device names is judged against the commit its base was taken at, which can be older than the position.
			const since = new Map(paths.map((p) => [p.path, (p.at === undefined ? undefined : place.get(p.at)) ?? at]));
			for (const { path } of paths) changed.add(path);
			return {
				main: head.id,
				full: false,
				walked,
				commits: chain.slice(at + 1),
				files: [...changed].sort().map((path) => {
					const hash = trees.read(head.tree, path);
					return { path, hash, ...(hash !== null && replacedSince(since.get(path) ?? at, path) ? { replaced: true as const } : {}) };
				}),
			};
		},
		/** Texts by hash: a content-addressed read, never stale. */
		fetch: (hashes: string[]) => Object.fromEntries(hashes.flatMap((hash) => (blobs.has(hash) ? [[hash, blobs.get(hash) as string]] : []))),
		subscribe(listener: (event: Event) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/**
		 * Turn the live commits since the last flush into one snapshot commit
		 * with the design's message. Their recorded outcomes go with them.
		 */
		flush() {
			const last = flushes.at(-1);
			const from = (last?.through ?? 0) + 1;
			if (from >= chain.length) return null;
			const range = chain.slice(from).map((id) => commits.get(id) as Stored);
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
					c.overlaps.map((o) => `Epicenter-Overlap: ${o.path} ${o.unit} (${o.current.user}/${o.current.device}, ${o.incoming.user}/${o.incoming.device})`),
				),
				...range.flatMap((c) => c.siblings.map((s) => `Epicenter-Sibling: ${s.to} from ${s.from}`)),
				...[...counts.keys()].sort().map((user) => `Co-authored-by: ${user[0]?.toUpperCase()}${user.slice(1)} <${user}@example.com>`),
			];
			const author = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'epicenter';
			const message = `${subject}\n\n${paths.join('\n')}\n\n${trailers.join('\n')}\n`;
			const id = createHash('sha1').update(`${last?.id ?? ''}\n${head.tree}\n${author}\n${message}`).digest('hex');
			flushes.push({ id, tree: head.tree, message, through: chain.length - 1 });
			for (const live of taken) {
				flushedInto.set(live, id);
				outcomes.delete(live);
			}
			return { id, author, message };
		},
		/** Live commits on `main` and their approximate bytes (paths, texts, ~200 bytes of metadata each), for the benchmark. */
		history: () => ({ commits: chain.length - 1, bytes: liveBytes, flushes: flushes.length }),
	};
}

export type Server = ReturnType<typeof createServer>;
