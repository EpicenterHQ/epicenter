/**
 * The Git receive path (D1): a `git push` of `refs/heads/main`, whose
 * objects a transport has already written to Git, is taken only as a
 * fast-forward of Git's `main` at the last flush, with no live edits that
 * Git does not hold yet (`unflushed`: a limitation of Epicenter's, not
 * Git's, ADR-0697). Every pushed commit must have exactly one parent, and every
 * path each one changes passes the door (`admissible`, regular files only,
 * strict UTF-8, Epicenter's `.gitattributes` untouched, a pointer's bytes
 * present at its size,
 * one spelling per folded path), so no commit in `main`'s history breaks a
 * rule even if a later one repairs it.
 *
 * Accepted, the pushed change becomes one live commit whose parent is the
 * live `main` Git holds. It lands only if the live `main` is still that
 * commit, checked in the transaction that applies it: a live commit that
 * landed while the push was being checked refuses the push as `unflushed`,
 * never merged. That transaction journals the move of Git's `main`, as a
 * flush is journaled (flush.ts); only then does Git's `main` move, by
 * compare-and-swap. A push the live door refuses never moves Git, so a
 * published `main` is never rewound, and a crash after Git moved is
 * finished by the next flush.
 */
import { type CommitFile, commitId, type LiveCommit } from '../core/commit.js';
import { admissible, ATTRIBUTES, fold } from '../core/door.js';
import { parsePointer } from '../core/markdown.js';
import { first, type SqlDriver } from '../sql.js';
import type { Flusher } from './flush.js';
import { type GitObjects, MAIN, type Tree } from './git-store.js';
import { type History, holdsBlob } from './history.js';
import type { Limits, PushAnswer, Session } from './server.js';

/**
 * Why a push was refused: who sent it, the ref, live edits Git does not
 * hold yet (a flush is started), Git's `main` moved outside Epicenter (an
 * operator's to reconcile), Git's `main` is not the push's old value, the
 * commits' shape (not a fast-forward, too many, a merge, missing), one
 * commit's file (`commit` and `path` name it), or the door's refusal of
 * the live commit the change became.
 */
export type ReceiveCode = 'not-member' | 'reader' | 'not-main' | 'unflushed' | 'diverged' | 'main-moved' | 'history' | 'file' | 'live';

/** Why a push is refused while live edits are not in Git. */
const UNFLUSHED = 'live edits are not in Git yet; a flush is scheduled, fetch and retry';

/** Why nothing is taken while a flush is diverged. */
export const DIVERGED = "Git's main moved outside Epicenter; flushes stop until an operator puts it back";

export type ReceiveAnswer =
	| { kind: 'accepted'; main: string; live: PushAnswer }
	| { kind: 'refused'; code: ReceiveCode; reason: string; commit?: string; path?: string };

const decoder = new TextDecoder('utf-8', { fatal: true });

export function createReceiver({
	history,
	store,
	git,
	clock,
	limits,
	flusher,
	apply,
}: {
	history: History;
	store: SqlDriver;
	git: GitObjects;
	clock: () => number;
	limits: Limits;
	flusher: Flusher;
	/** Apply a live commit past the rate limit (its checks were made against Git), only on its parent, running `during` in its transaction once it lands; null when `main` moved past its parent. */
	apply: (commit: LiveCommit, session: Session, during: () => void) => PushAnswer | null;
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
			// A push is a fast-forward of Git's `main`, which holds every live edit (nothing is unflushed), so it saw the bytes it replaces: any blob may be written, moved or deleted, once its bytes are here.
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

	async function receiveInside({ ref, old, next }: { ref: string; old: string | null; next: string }, session: Session): Promise<ReceiveAnswer> {
		if (session.role === null) return refused('not-member', 'not a member');
		if (session.role === 'reader') return refused('reader', 'a reader may not write');
		if (ref !== MAIN) return refused('not-main', 'only a fast-forward of refs/heads/main is accepted');
		if (flusher.diverged() !== null) return refused('diverged', DIVERGED);
		const start = history.top();
		if (start > meta.number('flushed') || first(store, 'SELECT 1 FROM journal LIMIT 1') !== undefined)
			return refused('unflushed', UNFLUSHED);
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

		// The pushed change as one live commit on top, from the state Git held.
		const files: CommitFile[] = [];
		for (const path of new Set([...base.keys(), ...last.keys()])) {
			if (path === '.gitattributes' || base.get(path)?.oid === last.get(path)?.oid) continue;
			const entry = last.get(path);
			files.push({ path, text: entry === undefined ? null : decoder.decode((await git.readBlob(entry.oid)) ?? new Uint8Array()) });
		}
		const tree = chain.at(-1)?.tree as string;
		const staging = `refs/heads/epicenter-receive-${next}`;
		if (!(await git.updateRef(staging, next, null)) && (await git.readRef(staging)) !== next) throw new Error(`the staging ref ${staging} moved`);
		const at = clock();
		const body = {
			parent: history.at(start).id,
			author: { user: session.user, device: 'git' },
			time: new Date(at).toISOString(),
			files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
		};
		// One transaction: the live commit, and the journal row that moves Git's main to the pushed commit. Git moves only after both are kept.
		const live = apply({ id: commitId(body), ...body }, session, () => {
			// The live tree as Git holds it, so the next flush diffs against Git's tree from the nodes it keeps.
			history.trees.update(history.main().tree, [[['.gitattributes'], history.keep(ATTRIBUTES)]]);
			flusher.journalPushed({ old, next, tree, through: history.top(), staging, user: session.user, at });
		});
		if (live === null || live.kind !== 'applied') {
			await git.deleteRef(staging, next);
			// D1: a live commit landed while the push was checked: refused, never merged.
			if (live === null) return refused('unflushed', UNFLUSHED);
			return refused('live', live.kind === 'refused' || live.kind === 'rejected' ? live.reason : 'the live commit did not land');
		}
		const finished = await flusher.finish();
		if (finished.kind === 'diverged') return refused('diverged', DIVERGED);
		return { kind: 'accepted', main: next, live };
	}

	return {
		/** Take a push of `ref` from `old` to `next`, whose objects are in Git; one at a time with flushes. */
		receive: (push: { ref: string; old: string | null; next: string }, session: Session): Promise<ReceiveAnswer> =>
			flusher.exclusive(() => receiveInside(push, session)),
	};
}
