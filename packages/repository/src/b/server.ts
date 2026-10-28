/**
 * Design B's server, in memory: the shared working tree, conditional writes
 * of several files at once, the parse rule, a notification stream that says
 * only "the tree is now T; these paths changed, to these hashes", reads of
 * texts by hash, catch-up by tree diff, and per-path history so a stale
 * write can be told that its path now holds a different note.
 *
 * The server never merges. It orders writes, checks each file's expected
 * hash, enforces `breaksParsing`, and answers `applied` or `stale`.
 *
 * Rules this server needed that the design README does not state are marked
 * `RULE:` and listed in the deciding test's report.
 */
import { createHash } from 'node:crypto';
import { gitBlobHash } from '../hash.js';
import { breaksParsing } from '../markdown.js';

// ============================================================================
// Protocol
// ============================================================================

/**
 * A file's state at the server; hash null means no file.
 *
 * RULE: `note` names which note the path holds. A path deleted and created
 * again holds a new note, even with the very text the old one had (a note
 * made from a template), and a blob hash cannot tell the two apart. The
 * design has no such id; without it the deciding test merged a stale edit
 * into a replacement note (seed 220). It is server state beside the working
 * tree, not Git content.
 */
export type FileHash = {
	path: string;
	hash: string | null;
	note: number | null;
};

/** A file's state with its text. */
export type FileState = FileHash & { text: string | null };

export type WriteFile = {
	path: string;
	/** The hash the device last heard, or null for "absent". Missing means no condition: refused (HTTP 428). */
	expected: string | null;
	/** The new text, or null to delete. */
	text: string | null;
	/**
	 * The note the device's base belongs to; a write to the path is stale when
	 * it holds another. On a create (`expected` null) it brings back that note,
	 * deleted under an unsent edit (RULE), so a later stale edit of it still
	 * merges instead of becoming a sibling.
	 */
	note?: number;
};

export type WriteAnswer =
	/** RULE: `prior` is the tree the write was applied on, so a device knows whether its own tree is still whole. */
	| { kind: 'applied'; prior: string; tree: string; notes: Record<string, number | null> }
	/** `tree` is the server's tree when it found the write stale; `files` are as of then, with their texts (412). */
	| { kind: 'stale'; tree: string; files: FileState[] }
	| { kind: 'refused'; path: string; reason: string }
	| { kind: 'precondition-required'; path: string };

/** A write the device sent whose answer it never heard. */
export type Unanswered = { path: string; expected: string | null; sent: string | null };

export type CatchUp = {
	/** Every file, because the server did not know the device's tree. */
	full: boolean;
	tree: string;
	/** Paths and hashes only; the device reads the texts by hash. */
	files: FileHash[];
	/**
	 * RULE: paths of the device's unanswered write whose sent text the path
	 * held after the expected hash, in the same note. Without this a lost reply
	 * followed by more typing and someone else's edit conflicts with itself.
	 */
	landed: string[];
	/** Directory entries compared to find `files`, for the benchmark. */
	compared: number;
};

/** One notification: the tree is now `tree`; these paths changed, to these hashes. No texts. */
export type Event = { tree: string; by: string; files: { path: string; hash: string | null }[] };

/** One applied write, for audits: what each file was, became, and which note it was. */
export type Applied = {
	by: string;
	files: { path: string; before: string | null; after: string | null; note?: number; incarnation: number | null; revived: boolean }[];
};

// ============================================================================
// Trees: Git tree objects, content-addressed and kept, so any tree a device
// heard can be diffed against the current one
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

	/** Paths whose blob differs between two trees, with the hash each had in `from`. */
	function diff(from: string, to: string) {
		const out: { path: string; before: string | null }[] = [];
		let compared = 0;
		const walk = (a: string, b: string, prefix: string) => {
			if (a === b) return;
			const left = nodes.get(a) ?? new Map<string, Entry>();
			const right = nodes.get(b) ?? new Map<string, Entry>();
			for (const name of new Set([...left.keys(), ...right.keys()])) {
				compared++;
				const x = left.get(name);
				const y = right.get(name);
				if (x?.hash === y?.hash && x?.tree === y?.tree) continue;
				const path = prefix + name;
				if (x?.tree || y?.tree) walk(x?.tree ? x.hash : empty, y?.tree ? y.hash : empty, `${path}/`);
				if ((x !== undefined && !x.tree) || (y !== undefined && !y.tree))
					out.push({ path, before: x !== undefined && !x.tree ? x.hash : null });
			}
		};
		walk(from, to, '');
		return { changed: out, compared };
	}

	return { empty, update, diff, has: (tree: string) => nodes.has(tree) };
}

// ============================================================================
// The server
// ============================================================================

type Incarnation = { id: number; hashes: string[]; open: boolean };

export function createServer({ onApplied }: { onApplied?: (applied: Applied) => void } = {}) {
	const files = new Map<string, { text: string; hash: string }>();
	/** Every text ever held, by hash (Git's object store). */
	const blobs = new Map<string, string>();
	const history = new Map<string, Incarnation[]>();
	const trees = createTreeStore();
	const listeners = new Set<(event: Event) => void>();
	const commits: { tree: string; files: Map<string, string> }[] = [];
	let root = trees.empty;
	let nextIncarnation = 1;

	const current = (path: string) => {
		const last = history.get(path)?.at(-1);
		return last?.open ? last : undefined;
	};
	const state = (path: string): FileState => {
		const file = files.get(path);
		return { path, text: file?.text ?? null, hash: file?.hash ?? null, note: current(path)?.id ?? null };
	};

	function write(by: string, files_: WriteFile[]): WriteAnswer {
		const seen = new Set<string>();
		for (const file of files_) {
			if (file.expected === undefined) return { kind: 'precondition-required', path: file.path };
			if (seen.has(file.path)) return { kind: 'refused', path: file.path, reason: 'a path is named twice' };
			seen.add(file.path);
		}
		const stale: FileState[] = [];
		for (const file of files_) {
			const now = files.get(file.path);
			const note = current(file.path)?.id;
			const sameNote = file.expected === null || file.note === undefined || file.note === note;
			if ((now?.hash ?? null) === file.expected && sameNote) continue;
			stale.push(state(file.path));
		}
		if (stale.length > 0) return { kind: 'stale', tree: root, files: stale };
		for (const file of files_) {
			const before = files.get(file.path)?.text ?? null;
			if (breaksParsing(file.path, before, file.text))
				return { kind: 'refused', path: file.path, reason: 'the frontmatter would no longer parse' };
		}

		const applied: Applied = { by, files: [] };
		const changes: [string[], string | null][] = [];
		for (const file of files_) {
			const before = files.get(file.path)?.text ?? null;
			const incarnationBefore = current(file.path)?.id ?? null;
			const incarnations = history.get(file.path) ?? [];
			history.set(file.path, incarnations);
			let revived = false;
			let hash: string | null = null;
			if (file.text === null) {
				files.delete(file.path);
				const note = current(file.path);
				if (note !== undefined) note.open = false;
			} else {
				hash = gitBlobHash(file.text);
				files.set(file.path, { text: file.text, hash });
				blobs.set(hash, file.text);
				const note = current(file.path);
				if (note !== undefined) note.hashes.push(hash);
				else {
					const at = file.note === undefined ? -1 : incarnations.findIndex((i) => i.id === file.note);
					const [back] = at < 0 ? [] : incarnations.splice(at, 1);
					revived = back !== undefined;
					incarnations.push(
						back === undefined ? { id: nextIncarnation++, hashes: [hash], open: true } : { ...back, hashes: [...back.hashes, hash], open: true },
					);
				}
			}
			changes.push([file.path.split('/'), hash]);
			applied.files.push({
				path: file.path,
				before,
				after: file.text,
				...(file.note === undefined ? {} : { note: file.note }),
				incarnation: incarnationBefore,
				revived,
			});
		}
		const prior = root;
		root = trees.update(root, changes);
		onApplied?.(applied);
		const event: Event = { tree: root, by, files: files_.map((file) => ({ path: file.path, hash: files.get(file.path)?.hash ?? null })) };
		for (const listener of listeners) listener(event);
		return {
			kind: 'applied',
			prior,
			tree: root,
			notes: Object.fromEntries(files_.map((file) => [file.path, current(file.path)?.id ?? null])),
		};
	}

	/** Did the path hold `sent` after `expected`, in the note there now? */
	function landed({ path, expected, sent }: Unanswered) {
		if (sent === null) return !files.has(path);
		const hashes = current(path)?.hashes ?? [];
		const at = hashes.lastIndexOf(sent);
		if (at < 0) return false;
		if (expected === null) return true;
		const from = hashes.indexOf(expected);
		return from >= 0 && from < at;
	}

	return {
		/** The current tree hash. */
		tree: () => root,
		read: (path: string) => files.get(path)?.text ?? null,
		/** Every path and text, sorted. */
		snapshot: () => new Map([...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, file]) => [path, file.text])),
		note: (path: string) => current(path)?.id ?? null,
		/**
		 * Set files if each is still at its expected hash: all or nothing. A file
		 * with no expectation refuses the whole write (HTTP 428).
		 */
		write,
		/**
		 * What changed since `from`, a tree this device heard: the paths a tree
		 * diff finds, plus the current state of `paths` (RULE: files whose base
		 * the device took from a reply ahead of its tree). An unknown tree gets
		 * every file. Each says which note it is, so the device can tell a
		 * replacement from an edit.
		 */
		catchUp({ from, paths = [], unanswered = [] }: { from: string | null; paths?: string[]; unanswered?: Unanswered[] }): CatchUp {
			const known = from !== null && trees.has(from);
			const { changed, compared } = known
				? trees.diff(from, root)
				: { changed: [...files.keys()].map((path) => ({ path, before: null as string | null })), compared: files.size };
			const listed = new Set(changed.map((c) => c.path));
			for (const path of paths) if (!listed.has(path)) changed.push({ path, before: null });
			return {
				full: !known,
				tree: root,
				compared,
				files: changed.map(({ path }) => {
					const { text: _, ...answer } = state(path);
					return answer;
				}),
				landed: unanswered.filter(landed).map((u) => u.path),
			};
		},
		/** Texts by hash: a content-addressed read, never stale. */
		fetch: (hashes: string[]) => Object.fromEntries(hashes.flatMap((hash) => (blobs.has(hash) ? [[hash, blobs.get(hash) as string]] : []))),
		subscribe(listener: (event: Event) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** Snapshot the working tree as a commit. */
		commit() {
			commits.push({ tree: root, files: new Map([...files].map(([path, file]) => [path, file.hash])) });
			return root;
		},
		commits: () => commits.length,
	};
}

export type Server = ReturnType<typeof createServer>;
