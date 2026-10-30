/**
 * The Git receive path (D1): a `git push` of `refs/heads/main`, whose
 * objects a transport has already written to Git, is taken as a
 * fast-forward of Git's `main` (Git's own ref rule: its old value must be
 * Git's `main`). Every pushed commit must have exactly one parent, and every
 * path each one changes passes the door (`admissible`, regular files only,
 * strict UTF-8, Epicenter's `.gitattributes` untouched, a pointer's bytes
 * present at its size, one spelling per folded path), so no commit in
 * `main`'s history breaks a rule even if a later one repairs it.
 *
 * Accepted, the pushed change becomes one live commit on the live commit
 * Git's `main` stands for (the flushed place, or, while a pushed commit
 * waits to be joined, the live commit that push became), merged into live
 * `main` like any commit: every note merges, a blob by compare-and-swap. A
 * live edit Git does not hold yet, or one that lands while the push is
 * checked, is merged, never a refusal (ADR-0697). The transaction that
 * merges it journals the move of Git's `main` to exactly the pushed commit,
 * as a flush is journaled (flush.ts), and records the push as received;
 * only then does Git's `main` move, by compare-and-swap. A merged push does
 * not move the flushed place: Git holds the push, not the live edits it was
 * merged over, which the next flush joins to it. Once the window dropped
 * the live commit Git's `main` stands for, live history is flushed first,
 * so the push meets `main-moved` under Git's own rule. A push the live door
 * refuses never moves Git, so a published `main` is never rewound; a crash
 * after the transaction is finished by the next flush or push, and the push
 * sent again is answered accepted.
 */
import { type CommitFile, commitId, type LiveCommit } from '../core/commit.js';
import { admissible, ATTRIBUTES, fold } from '../core/door.js';
import { gitBlobHash } from '../core/hash.js';
import { parsePointer } from '../core/markdown.js';
import { first, type SqlDriver } from '../sql.js';
import type { Flusher, FlushStep, Join } from './flush.js';
import { type GitObjects, MAIN, type Tree } from './git-store.js';
import { type History, holdsBlob } from './history.js';
import type { Limits, PushAnswer, Session } from './server.js';

/**
 * Why a push was refused: who sent it, the ref, Git's `main` moved outside
 * Epicenter (an operator's to reconcile), Git's `main` is not the push's
 * old value, the commits' shape (not a fast-forward, too many, a merge,
 * missing), one commit's file (`commit` and `path` name it), or the door's
 * refusal of the live commit the change became (`path` names a file the
 * merge refused, such as a blob changed since the push's old value, or a
 * file where live `main` has a folder of its name).
 */
export type ReceiveCode = 'not-member' | 'reader' | 'not-main' | 'diverged' | 'main-moved' | 'history' | 'file' | 'live';

/** Why nothing is taken while a flush is diverged. */
export const DIVERGED = "Git's main moved outside Epicenter; flushes stop until an operator puts it back";

/**
 * `accepted`: the push is taken, once, and `main` (the pushed commit) is
 * in Git's history from now on; `head` is Git's `main` (the pushed commit
 * until a flush joins live edits to it); `merged` when it was merged over
 * live edits; `published` false only while a flush is diverged, so Git's
 * `main` waits for an operator before it moves.
 */
export type ReceiveAnswer =
	| { kind: 'accepted'; main: string; head: string | null; merged: boolean; published: boolean }
	| { kind: 'refused'; code: ReceiveCode; reason: string; commit?: string; path?: string };

const decoder = new TextDecoder('utf-8', { fatal: true });

export function createReceiver({
	history,
	store,
	git,
	clock,
	limits,
	flusher,
	faults,
	apply,
	prune,
}: {
	history: History;
	store: SqlDriver;
	git: GitObjects;
	clock: () => number;
	limits: Limits;
	flusher: Flusher;
	faults?: (step: FlushStep) => void;
	/** Apply a live commit past the rate limit (its checks were made against Git), running `during` in its transaction once it lands. */
	apply: (commit: LiveCommit, session: Session, during: (answer: PushAnswer & { kind: 'applied' | 'merged' }) => void) => PushAnswer;
	/** Drop what the window no longer keeps, as every live commit does first. */
	prune: () => void;
}) {
	const { meta } = history;
	const refused = (code: ReceiveCode, reason: string, at: { commit?: string; path?: string } = {}): ReceiveAnswer => ({ kind: 'refused', code, reason, ...at });

	/** Why `tree` may not follow `parent` in `main`'s history, or null. */
	async function check(oid: string, parent: Tree, tree: Tree): Promise<ReceiveAnswer | null> {
		const folded = new Map<string, string>();
		for (const path of tree.keys()) {
			const other = folded.get(fold(path));
			if (other !== undefined) return refused('file', `'${other}' and '${path}' are one path`, { commit: oid, path });
			folded.set(fold(path), path);
		}
		for (const path of new Set([...parent.keys(), ...tree.keys()])) {
			const before = parent.get(path);
			const after = tree.get(path);
			if (before?.oid === after?.oid && before?.mode === after?.mode) continue;
			const at = { commit: oid, path };
			if (after === undefined) {
				if (path === '.gitattributes') return refused('file', 'Epicenter owns this file', at);
				const reason = admissible(path, null);
				if (reason !== null) return refused('file', reason, at);
				continue;
			}
			if (after.mode !== '100644') return refused('file', 'only regular files may be pushed', at);
			const bytes = await git.readBlob(after.oid);
			if (bytes === null) return refused('file', 'a pushed blob is missing', at);
			let text: string;
			try {
				text = decoder.decode(bytes);
			} catch {
				return refused('file', 'binary files go through Git LFS', at);
			}
			const reason = path === '.gitattributes' ? (text === ATTRIBUTES ? null : 'Epicenter owns this file') : admissible(path, text);
			if (reason !== null) return refused('file', reason, at);
			// Any blob may be written, moved or deleted once its bytes are here; whether it still holds what the push saw is the live merge's compare-and-swap.
			const pointer = parsePointer(text);
			if (pointer !== null && !holdsBlob(store, pointer)) return refused('file', "the file's bytes are not on the server", at);
		}
		return null;
	}

	/** The commits from `next` back to `old`, oldest first, or why they are not a fast-forward. */
	async function walk(old: string | null, next: string) {
		const chain: { oid: string; tree: string; parent: string | null }[] = [];
		let at: string | null = next;
		while (at !== old) {
			if (at === null) return refused('history', 'not a fast-forward of main; fetch and rebase');
			if (chain.length >= limits.pushedCommits) return refused('history', `a push may hold at most ${limits.pushedCommits} commits`);
			const info = await git.readCommit(at);
			if (info === null) return refused('history', 'a pushed commit is missing', { commit: at });
			const [parent = null, ...more] = info.parents;
			if (more.length > 0) return refused('history', 'a pushed commit may have only one parent; rebase instead of merging', { commit: at });
			chain.unshift({ oid: at, tree: info.tree, parent });
			at = parent;
		}
		return chain;
	}

	/**
	 * The live commit Git's `main` stands for: the flushed place, or, while a
	 * pushed commit waits to be joined, the live commit it became. Undefined
	 * once the window dropped it, like any live history: ask after `prune`,
	 * as the live commit a push becomes prunes first.
	 */
	function standsFor(): string | undefined {
		const waiting = flusher.joins().at(-1);
		if (waiting !== undefined) return history.baseOf(waiting.side) === undefined ? undefined : waiting.side;
		const flushed = meta.number('flushed');
		return flushed < history.offset() ? undefined : history.at(flushed).id;
	}

	/** The answer to a push already taken: Git's `main` holds it once its row is finished. */
	async function taken(next: string, merged: boolean): Promise<ReceiveAnswer> {
		if (flusher.diverged() !== null) return { kind: 'accepted', main: next, head: meta.get('git_head') || null, merged, published: false };
		if (first(store, 'SELECT 1 FROM journal LIMIT 1') !== undefined && (await flusher.finish()).kind === 'diverged')
			return { kind: 'accepted', main: next, head: meta.get('git_head') || null, merged, published: false };
		return { kind: 'accepted', main: next, head: meta.get('git_head') || null, merged, published: true };
	}

	async function receiveInside({ ref, old, next }: { ref: string; old: string | null; next: string }, session: Session): Promise<ReceiveAnswer> {
		if (session.role === null) return refused('not-member', 'not a member');
		if (session.role === 'reader') return refused('reader', 'a reader may not write');
		if (ref !== MAIN) return refused('not-main', 'only a fast-forward of refs/heads/main is accepted');
		// RULE: a push taken before (its answer lost, or the server crashed after taking it) is answered accepted, never taken twice.
		const before = first<{ merged: number }>(store, 'SELECT merged FROM received WHERE next = ?', [next]);
		if (before !== undefined) return taken(next, before.merged === 1);
		if (flusher.diverged() !== null) return refused('diverged', DIVERGED);
		// A row a crash left (a flush, or a push) was decided before this push: finish it, then check the ref against where it left Git.
		if (first(store, 'SELECT 1 FROM journal LIMIT 1') !== undefined && (await flusher.finish()).kind === 'diverged') return refused('diverged', DIVERGED);
		// RULE: a push merges on the live commit Git's `main` stands for; once the window dropped it, live history is flushed first (Git's `main` moves, so this push is refused below).
		prune();
		if (standsFor() === undefined && (await flusher.flushHere()).kind === 'diverged') return refused('diverged', DIVERGED);
		const head = meta.get('git_head') || null;
		if (old !== head || (await git.readRef(MAIN)) !== old) return refused('main-moved', 'main moved; fetch and rebase');
		const chain = await walk(old, next);
		if (!Array.isArray(chain)) return chain;
		let parentTree: Tree = old === null ? new Map() : await git.readTree((await git.readCommit(old))?.tree ?? '');
		const base = parentTree;
		let last = parentTree;
		for (const commit of chain) {
			const tree = await git.readTree(commit.tree);
			const refusal = await check(commit.oid, parentTree, tree);
			if (refusal !== null) return refusal;
			parentTree = tree;
			last = tree;
		}

		// The pushed change as one live commit on the live commit Git's `main` stands for.
		const files: CommitFile[] = [];
		for (const path of new Set([...base.keys(), ...last.keys()])) {
			if (path === '.gitattributes' || base.get(path)?.oid === last.get(path)?.oid) continue;
			const entry = last.get(path);
			files.push({ path, text: entry === undefined ? null : decoder.decode((await git.readBlob(entry.oid)) ?? new Uint8Array()) });
		}
		files.sort((a, b) => (a.path < b.path ? -1 : 1));
		const tree = chain.at(-1)?.tree as string;
		const staging = `refs/heads/epicenter-receive-${next}`;
		if (!(await git.updateRef(staging, next, null)) && (await git.readRef(staging)) !== next) throw new Error(`the staging ref ${staging} moved`);
		// Asked again after the last wait, so nothing lands between this and the live commit.
		prune();
		const parent = standsFor();
		if (parent === undefined) {
			// Dropped during the checks (it was at the window's edge): sent again, the push finds it gone and flushes first.
			await git.deleteRef(staging, next);
			return refused('live', 'the live commit this push merges on left the window while the push was checked; push again');
		}
		const at = clock();
		const body = {
			parent,
			author: { user: session.user, device: 'git' },
			time: new Date(at).toISOString(),
			files,
		};
		const id = commitId(body);
		// One transaction: the live commit, the journal row that moves Git's main to the pushed commit, and the record that the push was taken. Git moves only after all three are kept.
		const live = apply({ id, ...body }, session, (landed) => {
			const merged = landed.kind === 'merged';
			const flushed = meta.number('flushed');
			// The trees of `old` and of the pushed commit as live history holds them, so a flush diffs against them from the nodes it keeps.
			const base = history.trees.update(history.baseOf(parent)?.tree ?? history.trees.empty, [[['.gitattributes'], history.keep(ATTRIBUTES)]]);
			const pushed = history.trees.update(base, files.map((f): [string[], string | null] => [f.path.split('/'), f.text === null ? null : gitBlobHash(f.text)]));
			const join: Join | undefined = merged ? { old, base, oid: next, tree: pushed, place: history.top(), side: id } : undefined;
			// Applied on Git's `main` with nothing waiting, Git holds all of live history; merged, it holds the push, not the live edits it was merged over.
			flusher.journalPushed({ old, next, tree, through: merged ? flushed : history.top(), staging, user: session.user, at, ...(join === undefined ? {} : { join }) });
			store.run('INSERT INTO received (next, merged, at) VALUES (?, ?, ?)', [next, merged ? 1 : 0, at]);
		});
		if (live.kind !== 'applied' && live.kind !== 'merged') {
			await git.deleteRef(staging, next);
			const reason = live.kind === 'refused' || live.kind === 'rejected' ? live.reason : 'the live commit did not land';
			return refused('live', reason, live.kind === 'refused' ? { path: live.path } : {});
		}
		faults?.('received');
		return taken(next, live.kind === 'merged');
	}

	return {
		/** Take a push of `ref` from `old` to `next`, whose objects are in Git; one at a time with flushes. */
		receive: (push: { ref: string; old: string | null; next: string }, session: Session): Promise<ReceiveAnswer> =>
			flusher.exclusive(() => receiveInside(push, session)),
	};
}
