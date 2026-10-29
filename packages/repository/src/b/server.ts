/**
 * Design B's server, phase 0a, in memory: live history behind one door.
 *
 * Every applied write is a live commit `{ id, parents, author, time }` whose
 * id hashes its parent and content. `main` only moves forward: a commit on
 * `main` fast-forwards it; otherwise a `merge`-mode commit is merged by the
 * server, path by path, with `settle` (the one producer of what happened to
 * each file), and a `fast-forward`-mode commit is refused. A Git push is
 * always fast-forward only (D1).
 *
 * The door: a session names the member, who must be on the member list and
 * be the commit's author; the id must hash the commit; requests, files and
 * pushes per member are bounded; every file written is `admissible` (the
 * predicate the device runs too); and the tree rules hold: paths equal after
 * NFC and case folding are one path, a blob's path is immutable and its
 * bytes present, and a merge may not grow a note past 1 MB.
 *
 * Positions are trees kept for a retention window, so a catch-up is a tree
 * diff, in pages. Every replay table (commits, outcomes) is bounded by the
 * same window; after it, a push is answered `outcome-unknown`.
 *
 * Rules the design does not state are marked `RULE:`.
 */
import { createHash } from 'node:crypto';
import { type Author, type CommitFile, commitId, type LiveCommit } from '../core/commit.js';
import { gitBlobHash } from '../core/hash.js';
import { createTreeStore } from '../core/tree.js';
import { parsePointer } from '../core/markdown.js';
import { findConflicts } from '../core/conflict.js';
import { ATTRIBUTES, MAX_FILE_BYTES, admissible, fold, isNote } from '../core/door.js';
import { BLOCK_CAP, settle } from '../core/settle.js';

// ============================================================================
// Protocol
// ============================================================================

/** Who is asking: the member a session names. */
export type Session = { member: string };

/** A path's text on `main`; `deleted` when the path was deleted at some point since the commit or position asked from. */
export type FileState = { path: string; text: string | null; hash: string | null; deleted?: true };

export type PushAnswer =
	/**
	 * The commit is in `main`: fast-forwarded (`main` is the commit) or merged
	 * (`main` is the merge commit). `files` are `main`'s texts for every path
	 * changed since the commit's parent and every path it touched, so the
	 * device can stand on `main` at once. What became of each path is in the
	 * text itself (conflict blocks); the device compares what it sent.
	 */
	| {
			kind: 'applied' | 'merged';
			main: string;
			/** The commits on `main` after the commit's parent, so the device drops those notifications. */
			commits: string[];
			files: FileState[];
	  }
	/** Nothing changed: `main` moved and the commit asked to fast-forward, or the door refused it (`path` names the file at fault). */
	| { kind: 'refused'; reason: string; path?: string; main: string }
	/** RULE: the commit's parent, or its recorded outcome, is older than the retention window: the server cannot say what happened. */
	| { kind: 'outcome-unknown'; main: string };

/** A notification: the new commit, its parents, and the paths changed since its first parent, with hashes. No texts. */
export type Event = { commit: string; parents: string[]; files: { path: string; hash: string | null }[] };

export type CatchUp = {
	/** The commit this catch-up brings the device to. */
	main: string;
	/** Every file, because the server no longer keeps the position. */
	full: boolean;
	/** One page of paths changed since the position, with hashes. */
	files: { path: string; hash: string | null; deleted?: true }[];
	/** The commits walked (on the last page), so the device drops those notifications. */
	commits: string[];
	/** Ask again with `after` for the next page, or null on the last. */
	next: string | null;
};

/** One commit on `main`, for audits: what each path was and became. */
export type Committed = {
	id: string;
	parents: string[];
	author: Author;
	files: { path: string; before: string | null; after: string | null }[];
};

export type Limits = {
	/** Bytes of one push, as JSON. */
	request: number;
	files: number;
	path: number;
	/** Paths in one catch-up page. */
	page: number;
	/** Pushes per member: a bucket of `burst`, refilled at `rate` a second. */
	burst: number;
	rate: number;
	/** How long positions, commits and outcomes are kept, in ms. */
	window: number;
};

export const LIMITS: Limits = { request: 4 * 1024 * 1024, files: 1000, path: 512, page: 1000, burst: 30, rate: 10, window: 10 * 60_000 };

type Stored = {
	id: string;
	parents: string[];
	author: Author;
	time: string;
	at: number;
	tree: string;
	changes: Set<string>;
	deletes: Set<string>;
	/** A merge that wrote a conflict block: a Git commit of its own at the next flush. */
	blocks: boolean;
};

// ============================================================================
// The server
// ============================================================================

const SERVER: Author = { user: 'epicenter', device: 'server' };

export function createServer({
	now = () => 0,
	onCommit,
	members,
	limits: given = {},
}: { now?: () => number; onCommit?: (committed: Committed) => void; members?: Iterable<string>; limits?: Partial<Limits> } = {}) {
	const limits = { ...LIMITS, ...given };
	/** A live set: members added later count. */
	const memberList = members === undefined ? null : members instanceof Set ? (members as Set<string>) : new Set(members);
	const trees = createTreeStore();
	/** Every text ever held, by hash (Git's object store). */
	const blobs = new Map<string, string>();
	/** Live commits kept: those on `main` inside the window, and the devices' commits they merged. */
	const commits = new Map<string, Stored>();
	let chain: string[] = [];
	let offset = 0;
	const place = new Map<string, number>();
	const outcomes = new Map<string, { at: number; answer: PushAnswer; commit?: LiveCommit; spelled?: string[] }>();
	const listeners = new Set<(event: Event) => void>();
	const lastAuthor = new Map<string, Author>();
	const buckets = new Map<string, { tokens: number; at: number }>();
	const flushes: { id: string; tree: string; message: string; through: number }[] = [];
	/** LFS bytes the server holds, by oid. */
	const uploaded = new Set<string>();
	/** `main`'s paths by their folded identity. */
	const folded = new Map<string, string>();
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
		at: now(),
		tree: trees.empty,
		changes: new Set(),
		deletes: new Set(),
		blocks: false,
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
	/** Was the path deleted on `main` after place `from`? */
	const deletedSince = (from: number, path: string) => {
		for (let i = from + 1; i <= top(); i++) if (at(i).deletes.has(path)) return true;
		return false;
	};
	const state = (path: string, from?: number): FileState => {
		const hash = trees.read(main().tree, path);
		const text = hash === null ? null : (blobs.get(hash) ?? null);
		return { path, text, hash, ...(from !== undefined && deletedSince(from, path) ? { deleted: true as const } : {}) };
	};

	/** RULE: drop commits and outcomes older than the window (never `main` itself). */
	function prune() {
		const cutoff = now() - limits.window;
		let keep = top();
		while (keep > offset && at(keep - 1).at >= cutoff) keep--;
		for (let i = offset; i < keep; i++) {
			const commit = at(i);
			place.delete(commit.id);
			commits.delete(commit.id);
			for (const p of commit.parents.slice(1)) commits.delete(p);
		}
		chain = chain.slice(keep - offset);
		offset = keep;
		for (const [id, outcome] of outcomes) if (outcome.at < cutoff) outcomes.delete(id);
	}

	/** Put a commit on `main`: its snapshot and its notification. */
	function advance(stored: Omit<Stored, 'tree' | 'changes' | 'deletes' | 'at'>, files: CommitFile[]) {
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
		const deletes = new Set([...changes].filter((path) => trees.read(tree, path) === null));
		const commit: Stored = { ...stored, at: now(), tree, changes, deletes };
		for (const path of changes) {
			if (deletes.has(path)) folded.delete(fold(path));
			else folded.set(fold(path), path);
		}
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

	/** The door: who may push this, and is it something the repository may hold? */
	function admit(commit: LiveCommit, session: Session | undefined): PushAnswer | null {
		const head = main().id;
		const refuse = (reason: string, path?: string): PushAnswer => ({ kind: 'refused', reason, main: head, ...(path === undefined ? {} : { path }) });
		if (session === undefined) return refuse('no session');
		if (memberList !== null && !memberList.has(session.member)) return refuse('not a member');
		const bucket = buckets.get(session.member) ?? { tokens: limits.burst, at: now() };
		bucket.tokens = Math.min(limits.burst, bucket.tokens + ((now() - bucket.at) / 1000) * limits.rate);
		bucket.at = now();
		buckets.set(session.member, bucket);
		if (bucket.tokens < 1) return refuse('rate');
		bucket.tokens--;
		if (commit.parent === undefined) return refuse('no parent');
		// The id is checked before any recorded outcome is read, so a replayed id with other files is refused.
		if (commitId(commit) !== commit.id) return refuse('the id is not the hash of the commit');
		if (commit.author.user !== session.member) return refuse('the author is not the session');
		if (JSON.stringify(commit).length > limits.request) return refuse('request too large');
		if (commit.files.length > limits.files) return refuse('too many files');
		const paths = new Set<string>();
		const tree = main().tree;
		for (const file of commit.files) {
			if (file.path.length > limits.path) return refuse('bad path', file.path);
			if (paths.has(fold(file.path))) return refuse('a path is named twice', file.path);
			paths.add(fold(file.path));
			// D4 and the door's content rules: the same predicate the device runs.
			const reason = admissible(file.path, file.text);
			if (reason !== null) return refuse(reason, file.path);
			const pointer = file.text === null ? null : parsePointer(file.text);
			if (pointer === null) continue;
			if (!uploaded.has(pointer.oid)) return refuse("the blob's bytes are missing", file.path);
			const there = textIn(tree, folded.get(fold(file.path)) ?? file.path);
			if (there !== null && there !== file.text) return refuse("a blob's path is immutable", file.path);
		}
		return null;
	}

	function push(commit: LiveCommit, session?: Session, { git = false } = {}): PushAnswer {
		prune();
		const refusal = admit(commit, session);
		if (refusal !== null) return refusal;
		const recorded = outcomes.get(commit.id);
		if (recorded !== undefined) {
			// RULE: a resend gets its verdict brought up to now: `main` and every file changed since its parent, as they are now.
			const from = place.get(commit.parent);
			const answer = recorded.answer;
			if (from === undefined || recorded.commit === undefined || (answer.kind !== 'applied' && answer.kind !== 'merged')) return answer;
			const paths = new Set(trees.diff(at(from).tree, main().tree));
			for (const path of [...recorded.commit.files.map((f) => f.path), ...(recorded.spelled ?? [])]) paths.add(path);
			return { ...answer, main: main().id, commits: chain.slice(from + 1 - offset), files: [...paths].sort().map((path) => state(path, from)) };
		}
		// RULE: paths equal after NFC and case folding are one path: a write goes to the spelling `main` has.
		const spelled = commit.files.map((f) => f.path);
		commit = { ...commit, files: commit.files.map((f) => ({ ...f, path: folded.get(fold(f.path)) ?? f.path })) };
		const head = main();
		const from = place.get(commit.parent);
		if (from === undefined) return { kind: 'outcome-unknown', main: head.id };
		const forward = commit.parent === head.id;
		const refuse = (reason: string, path?: string): PushAnswer => ({ kind: 'refused', reason, main: head.id, ...(path === undefined ? {} : { path }) });
		// D1: a Git push is fast-forward only; the CLI rebases.
		if (git && !forward) return refuse('main moved; fetch and rebase');
		if (commit.mode === 'fast-forward' && !forward) return refuse('main moved');
		if (forward) {
			advance({ id: commit.id, parents: [commit.parent], author: commit.author, time: commit.time, blocks: false }, commit.files);
			return record(commit, 'applied', commit.id, from, spelled);
		}

		// Merge where the commit's history and main's meet, path by path.
		const parentTree = at(from).tree;
		const out: CommitFile[] = [];
		let blocks = false;
		for (const file of commit.files) {
			const ours = textIn(head.tree, file.path);
			const who = lastAuthor.get(file.path) ?? SERVER;
			const settled = settle(textIn(parentTree, file.path), ours, file.text, {
				deletedSince: deletedSince(from, file.path),
				parties: { current: { author: `${who.user}/${who.device}`, time: head.time }, incoming: { author: `${commit.author.user}/${commit.author.device}`, time: commit.time } },
			});
			// RULE, the one named exception: a merge that would grow a note past 1 MB is refused, so its writer holds it.
			if (settled.text !== null && isNote(file.path) && new TextEncoder().encode(settled.text).length > MAX_FILE_BYTES)
				return refuse('the merge would grow the note past 1 MB', file.path);
			// RULE: a merge may not leave a note with more than BLOCK_CAP conflict blocks (a stale-parent flood); its writer holds it, or an agent redoes it.
			if (settled.text !== null && isNote(file.path) && findConflicts(settled.text).length > Math.max(BLOCK_CAP, ours === null ? 0 : findConflicts(ours).length))
				return refuse('the note has too many conflict blocks', file.path);
			out.push({ path: file.path, text: settled.text });
			if (settled.disposition === 'conflict' || settled.disposition === 'different-note') blocks = true;
		}
		// The device's commit stays a real commit: the merge's second parent.
		for (const f of commit.files) if (f.text !== null) blobs.set(gitBlobHash(f.text), f.text);
		commits.set(commit.id, {
			id: commit.id,
			parents: [commit.parent],
			author: commit.author,
			time: commit.time,
			at: now(),
			tree: trees.update(parentTree, commit.files.map((f) => [f.path.split('/'), f.text === null ? null : gitBlobHash(f.text)])),
			changes: new Set(),
			deletes: new Set(),
			blocks: false,
		});
		const mergeTime = time();
		const id = commitId({ parent: `${head.id} ${commit.id}`, mode: 'merge', author: SERVER, time: mergeTime, files: out });
		advance({ id, parents: [head.id, commit.id], author: commit.author, time: mergeTime, blocks }, out);
		return record(commit, 'merged', id, from, spelled);
	}

	/** Fill an answer's files (everything changed since the commit's parent, and what it touched) and keep it for a resend inside the window. */
	function record(commit: LiveCommit, kind: 'applied' | 'merged', mainId: string, from: number, spelled: string[]): PushAnswer {
		const paths = new Set(trees.diff(at(from).tree, main().tree));
		// The device's own spellings come too, so a write folded into another spelling settles there.
		for (const path of [...commit.files.map((f) => f.path), ...spelled]) paths.add(path);
		const answer: PushAnswer = { kind, main: mainId, commits: chain.slice(from + 1 - offset), files: [...paths].sort().map((path) => state(path, from)) };
		outcomes.set(commit.id, { at: now(), answer, commit, spelled });
		return answer;
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
		/** Take a live commit over HTTP: fast-forward `main`, merge it in, or refuse it; a resend inside the window gets the recorded outcome. */
		push,
		/** Take a commit from `git push`: fast-forward only (D1). */
		gitPush: (commit: LiveCommit, session?: Session) => push(commit, session, { git: true }),
		/**
		 * What changed on `main` since `from`, as a tree diff, plus `paths` the
		 * device names, one page at a time: a later page names `to` (the commit
		 * the first page answered) and `after` (the last path it got). A
		 * position outside the window gets every file.
		 */
		catchUp({ from, paths = [], to, after }: { from: string | null; paths?: string[]; to?: string; after?: string }): CatchUp {
			prune();
			const target = to !== undefined && place.has(to) ? (commits.get(to) as Stored) : main();
			const index = from === null ? undefined : place.get(from);
			const full = index === undefined;
			const all = new Set(full ? trees.diff(trees.empty, target.tree) : trees.diff(at(index).tree, target.tree));
			for (const path of paths) all.add(path);
			const sorted = [...all].sort().filter((path) => after === undefined || path > after);
			const page = sorted.slice(0, limits.page);
			const last = page.length === sorted.length;
			return {
				main: target.id,
				full,
				files: page.map((path) => {
					const hash = trees.read(target.tree, path);
					return { path, hash, ...(!full && deletedSince(index, path) ? { deleted: true as const } : {}) };
				}),
				commits: last && !full ? chain.slice(index + 1 - offset, (place.get(target.id) ?? top()) + 1 - offset) : [],
				next: last ? null : (page.at(-1) ?? null),
			};
		},
		/** Texts by hash: a content-addressed read, never stale. */
		fetch: (hashes: string[]) => Object.fromEntries(hashes.flatMap((hash) => (blobs.has(hash) ? [[hash, blobs.get(hash) as string]] : []))),
		subscribe(listener: (event: Event) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** LFS bytes arrive (the upload track): pointers to them may now be written. */
		upload: (oid: string) => uploaded.add(oid),
		/**
		 * Turn the live commits since the last flush into Git commits: one at
		 * each merge that wrote a conflict block (so the value that lost is in
		 * Git history), and one at `main`. Epicenter's `.gitattributes` is in
		 * every flushed tree.
		 */
		flush() {
			const last = flushes.at(-1);
			const from = Math.max(offset, last?.through === undefined ? 0 : last.through + 1);
			if (from > top()) return null;
			const cuts: number[] = [];
			for (let i = from; i <= top(); i++) if (at(i).blocks) cuts.push(i);
			if (cuts.at(-1) !== top()) cuts.push(top());
			const made: { id: string; author: string; message: string }[] = [];
			let start = from;
			for (const end of cuts) {
				const range: Stored[] = [];
				for (let i = start; i <= end; i++) range.push(at(i));
				const previous = flushes.at(-1);
				const tree = trees.update(at(end).tree, [[['.gitattributes'], gitBlobHash(ATTRIBUTES)]]);
				const paths = trees.diff(previous?.tree ?? trees.empty, tree).filter((path) => path !== '.gitattributes').sort();
				start = end + 1;
				if (paths.length === 0 && !at(end).blocks) continue;
				const counts = new Map<string, number>();
				for (const commit of range) if (commit.author.user !== SERVER.user) counts.set(commit.author.user, (counts.get(commit.author.user) ?? 0) + 1);
				const short = (id: string) => id.slice(0, 7);
				const merge = at(end);
				const subject = merge.blocks
					? `Merge ${merge.author.user}'s change into ${paths[0] ?? 'main'}${paths.length > 1 ? ` and ${paths.length - 1} others` : ''}`
					: paths.length === 1
						? `Edit ${paths[0]}`
						: `Edit ${paths[0]} and ${paths.length - 1} others`;
				const trailers = [
					`Epicenter-Live: ${short(range[0]?.id ?? '')}..${short(merge.id)} (${range.length} commits)`,
					...[...counts.keys()].sort().map((user) => `Co-authored-by: ${user[0]?.toUpperCase()}${user.slice(1)} <${user}@example.com>`),
				];
				const author = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'epicenter';
				const message = `${subject}\n\n${paths.join('\n')}\n\n${trailers.join('\n')}\n`;
				const id = createHash('sha1').update(`${previous?.id ?? ''}\n${tree}\n${author}\n${message}`).digest('hex');
				flushes.push({ id, tree, message, through: end });
				made.push({ id, author, message });
			}
			const tail = made.at(-1);
			return tail === undefined ? null : { ...tail, commits: made };
		},
		/** Live commits ever made and kept, their approximate bytes, and flushes, for the benchmark. */
		history: () => ({ commits: made, kept: chain.length, outcomes: outcomes.size, bytes: liveBytes, flushes: flushes.length }),
	};
}

export type Server = ReturnType<typeof createServer>;
