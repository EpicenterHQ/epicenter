/**
 * The flush state machine: live history into real Git commits, recoverable
 * after a crash at any step (deployed spike 3 proved this design against
 * Artifacts at every step boundary, with duplicate and concurrent runs).
 *
 * 1. Intent (one Store transaction): plan the Git commits from the last
 *    flush to `main` (one at each merge that wrote a conflict block, so the
 *    value that lost is in Git history, then one at `main`), with their
 *    trees, messages and ids computed here, and the Git `main` expected.
 * 2. Stage: write the blobs, trees and commits Git lacks as one pack, with
 *    a staging ref at the tip, in one request. A flush therefore holds Git
 *    for a fixed number of requests however many commits it writes, and a
 *    push waiting behind it waits for no more.
 * 3. Compare-and-swap `main` from the expected commit to the tip.
 * 4. Complete (one transaction): record Git's head and how far it holds
 *    live history.
 * 5. Prune: delete the staging ref, then the journal row.
 *
 * Every run starts by finishing a journal row a crash left, reading Git's
 * `main` first: at the tip, the swap happened (record it); at the expected
 * commit, carry on from the recorded step; anywhere else, something outside
 * moved `main`, and the flush stops as `diverged`, its intent kept. RULE:
 * the recovery is an operator's: Epicenter never rewinds or merges a
 * `main` it did not write. Once Git's `main` is back at the expected
 * commit (the outside commit kept elsewhere), the next run finishes.
 *
 * A `git push` (receive.ts) is journaled the same way: its commit is
 * already in Git, so its row starts staged, with the staging ref at the
 * pushed commit, in the transaction that applies its live commit; the
 * compare-and-swap and completion are this machine's.
 *
 * A push merged over live edits Git does not hold yet leaves a join: Git's
 * `main` is the pushed commit, while live `main` is the merge that took it
 * in. Its row does not move the flushed place, so the journal never claims
 * Git holds an edit it lacks. The next flush exports those edits as a side
 * chain from the first join's old value (Git's `main` when they were made,
 * so each cut is a state that existed), and each join as one Git commit
 * whose first parent is the pushed commit and whose second is the side
 * chain's tip, with the live merge's tree, authored by Epicenter with every
 * writer it merges in as a co-author. Every pushed commit stays an
 * ancestor of `main`, no commit after it has a tree made without it, and
 * `main` ends at the live tree. A join waits under the same window as all
 * live history: once the window drops its place, its pushed commit stands
 * as the state, and the live edits it was merged over reach Git in the
 * next commit on it, as any history the window dropped reaches Git
 * coarser.
 *
 * Every Git commit's tree holds Epicenter's `.gitattributes`.
 */
import { ATTRIBUTES } from '../core/door.js';
import { type GitObject, gitCommitHash, gitCommitObject, gitTreeObject } from '../core/hash.js';
import { first, type SqlDriver } from '../sql.js';
import { type GitObjects, MAIN, type Signature } from './git-store.js';
import type { History } from './history.js';

/** A step boundary, where a crash can stop a flush (named for what has just happened). */
export type FlushStep = 'received' | 'intended' | 'staging-pushed' | 'staged' | 'main-moved' | 'completed' | 'staging-deleted';

export type FlushResult =
	| { kind: 'flushed'; head: string; commits: { oid: string; message: string; author: string }[] }
	| { kind: 'nothing' }
	/** Git's `main` is neither what this flush expected nor its tip: something outside moved it. The intent is kept. */
	| { kind: 'diverged'; main: string | null; expected: string | null };

type Planned = {
	oid: string;
	/** The tree id, `.gitattributes` included. */
	tree: string;
	parents: string[];
	message: string;
	author: Signature;
	/** Milliseconds since the epoch. */
	at: number;
	/** The blob ids this commit adds to its parent's tree. */
	blobs: string[];
	/** The tree ids this commit adds to its parent's tree. */
	trees: string[];
};

/**
 * A pushed commit Git's `main` moved to while live history ran ahead of
 * Git, waiting for the flush that joins them: the push's old value and the
 * tree it stands for, the pushed commit and its tree (the live tree it
 * became), the place of the live merge that took it in, and the live
 * commit it became (the next push on it is merged against this). Trees are
 * as live history holds them, `.gitattributes` included.
 */
export type Join = { old: string | null; base: string; oid: string; tree: string; place: number; side: string };

/** `join`: the join a push's row leaves once Git moved. */
type Plan = { expected: string | null; staging: string; through: number; commits: Planned[]; join?: Join };

/** Epicenter's own signature: every flushed commit's committer, and the author of a commit no member wrote (a join). */
export const COMMITTER: Signature = { name: 'Epicenter', email: 'noreply@epicenter.so' };
/** A member's Git signature. */
export const signatureOf = (user: string): Signature => ({ name: user, email: `${user}@users.epicenter.invalid` });

const encoder = new TextEncoder();
const short = (id: string) => id.slice(0, 7);

export function createFlusher({
	history,
	store,
	git,
	faults,
}: {
	history: History;
	store: SqlDriver;
	git: GitObjects;
	faults?: (step: FlushStep) => void;
}) {
	const { trees, meta } = history;
	/** Flushes and Git pushes run one at a time. */
	let queue: Promise<unknown> = Promise.resolve();
	function exclusive<T>(run: () => Promise<T>): Promise<T> {
		const next = queue.then(run, run);
		queue = next.catch(() => {});
		return next;
	}

	/** The joins waiting for a flush, oldest first. */
	const joins = (): Join[] => JSON.parse(meta.get('joins') ?? '[]') as Join[];

	/** The Git commits from the last flush to `main`, or null when Git already holds `main`'s content. */
	function plan(): Plan | null {
		const flushed = meta.number('flushed');
		const top = history.top();
		if (top <= flushed) return null;
		const from = Math.max(flushed + 1, history.offset());
		const waiting = joins();
		const joined = new Map(waiting.map((join) => [join.place, join]));
		// A merge that wrote a conflict block ends a Git commit.
		const cut = new Set<number>([top]);
		for (let i = from; i <= top; i++) if (history.at(i).blocks) cut.add(i);
		// A join is a Git commit of its own, and the live state it merged into ends the side chain's commit before it.
		for (const { place } of waiting) {
			if (place < from) continue;
			if (place - 1 >= from) cut.add(place - 1);
			cut.add(place);
		}
		const cuts = [...cut].sort((a, b) => a - b);
		const attributes = history.keep(ATTRIBUTES);
		const anchor = waiting[0];
		// With joins waiting, Git's `main` is a pushed commit: live edits start from the commit Git's `main` was when they were made.
		let previousTree = anchor === undefined ? (meta.get('git_tree') ?? trees.empty) : anchor.base;
		let previousOid = anchor === undefined ? meta.get('git_head') : anchor.old;
		/** Commits every later pushed commit descends from: a join on one of these needs no second parent. */
		const behind = new Set<string | null>(anchor === undefined ? [] : [anchor.old]);
		// A join whose place the window dropped: its pushed commit is the state, and the next commit on it carries the live edits it was merged over.
		for (const join of waiting) {
			if (join.place >= from) break;
			previousOid = join.oid;
			previousTree = join.tree;
			behind.add(join.oid);
		}
		const commits: Planned[] = [];
		let start = from;
		/** The first place whose writers the next join merges in. */
		let sideFrom = from;
		for (const end of cuts) {
			const range = Array.from({ length: end - start + 1 }, (_, k) => history.at(start + k));
			start = end + 1;
			const cut = history.at(end);
			const tree = trees.update(cut.tree, [[['.gitattributes'], attributes]]);
			const join = joined.get(end);
			let parents = previousOid === null || previousOid === '' ? [] : [previousOid];
			let against = previousTree;
			// Who wrote the change: a cut's own writers, or for a join, every writer of the live edits it merges into the push.
			let writers = range;
			if (join !== undefined) {
				// The join: first parent the pushed commit, so Git's first-parent history runs through every push and no commit after it lacks it.
				const side = !behind.has(previousOid);
				behind.add(join.oid);
				writers = Array.from({ length: end - sideFrom }, (_, k) => history.at(sideFrom + k));
				sideFrom = end + 1;
				if (!side && tree === join.tree) {
					// Nothing live to join: the pushed commit is the state.
					previousOid = join.oid;
					previousTree = join.tree;
					continue;
				}
				parents = side && previousOid !== null ? [join.oid, previousOid] : [join.oid];
				against = join.tree;
			} else if (tree === previousTree) {
				// RULE: a cut that changes nothing is no Git commit: Git records changes, and an unchanged tree has none to describe.
				continue;
			}
			const changed = trees.diff(against, tree);
			const paths = changed.filter((path) => path !== '.gitattributes').sort();
			const counts = new Map<string, number>();
			for (const commit of writers) if (commit.author.user !== 'epicenter') counts.set(commit.author.user, (counts.get(commit.author.user) ?? 0) + 1);
			const subject =
				join !== undefined
					? `Merge live edits into ${short(join.oid)}${cut.blocks ? ` with conflict blocks in ${paths[0] ?? 'main'}${paths.length > 1 ? ` and ${paths.length - 1} others` : ''}` : ''}`
					: cut.blocks
						? `Merge ${cut.author.user}'s change into ${paths[0] ?? 'main'}${paths.length > 1 ? ` and ${paths.length - 1} others` : ''}`
						: paths.length === 1
							? `Edit ${paths[0]}`
							: `Edit ${paths[0] ?? 'main'} and ${paths.length - 1} others`;
			const trailers = [
				`Epicenter-Live: ${short(range[0]?.id ?? '')}..${short(cut.id)} (${range.length} commits)`,
				...[...counts.keys()].sort().map((user) => {
					const { name, email } = signatureOf(user);
					return `Co-authored-by: ${name} <${email}>`;
				}),
			];
			const message = `${subject}\n\n${paths.join('\n')}\n\n${trailers.join('\n')}\n`;
			// RULE: a join is Epicenter's commit, not its pusher's: the pushed commit is the push, and the join is the live edits merged into it.
			const most = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
			const author = join !== undefined || most === undefined ? COMMITTER : signatureOf(most);
			const seconds = Math.floor(cut.at / 1000);
			const oid = gitCommitHash({ tree, parents, message, author: { ...author, at: seconds }, committer: { ...COMMITTER, at: seconds } });
			const blobs = [...new Set(changed.map((path) => trees.read(tree, path)).filter((hash): hash is string => hash !== null))];
			commits.push({ oid, tree, parents, message, author, at: cut.at, blobs, trees: trees.added(against, tree) });
			previousTree = tree;
			previousOid = oid;
		}
		if (commits.length === 0) {
			// Git's `main` already has the live tree: it is the last pushed commit, or what it was.
			meta.set('flushed', top);
			store.run("DELETE FROM meta WHERE key = 'joins'");
			return null;
		}
		const n = (first<{ n: number | null }>(store, 'SELECT MAX(n) AS n FROM flushes')?.n ?? 0) + 1;
		const expected = meta.get('git_head');
		return { expected: expected === '' ? null : expected, staging: `refs/heads/epicenter-staging-${n}`, through: top, commits };
	}

	/** Write every object the plan's commits add as one pack, with the staging ref at the tip: one request. */
	async function stage(plan: Plan) {
		const tip = plan.commits.at(-1)?.oid as string;
		const staged = await git.readRef(plan.staging);
		if (staged === tip) return;
		const objects: GitObject[] = [];
		const packed = new Set<string>();
		const add = (oid: string, object: () => GitObject) => {
			if (packed.has(oid)) return;
			packed.add(oid);
			objects.push(object());
		};
		for (const commit of plan.commits) {
			for (const hash of commit.blobs) {
				const text = history.blob(hash);
				if (text === null) throw new Error(`the flush lost the text of blob ${hash}`);
				add(hash, () => ({ kind: 'blob', bytes: encoder.encode(text) }));
			}
			for (const tree of commit.trees) {
				const entries = trees.entries(tree);
				if (entries === undefined) throw new Error(`the flush lost tree ${tree}`);
				add(tree, () => gitTreeObject([...entries]));
			}
			const at = Math.floor(commit.at / 1000);
			add(commit.oid, () => gitCommitObject({ tree: commit.tree, parents: commit.parents, message: commit.message, author: { ...commit.author, at }, committer: { ...COMMITTER, at } }));
		}
		// Another run of this flush may have staged it meanwhile.
		if (!(await git.writePack(objects, { name: plan.staging, next: tip, expected: staged })) && (await git.readRef(plan.staging)) !== tip) throw new Error(`the staging ref ${plan.staging} moved`);
	}

	function complete(n: number, plan: Plan) {
		const last = plan.commits.at(-1) as Planned;
		store.transaction(() => {
			// Another run of this flush may have completed it already.
			const row = first<{ state: string }>(store, 'SELECT state FROM journal WHERE n = ?', [n]);
			if (row === undefined || row.state === 'completed') return;
			meta.set('git_head', last.oid);
			meta.set('git_tree', last.tree);
			meta.set('flushed', Math.max(meta.number('flushed'), plan.through));
			// A merged push's row leaves its join; a flush joins every one (a push applied on Git's `main` happens only with none waiting).
			if (plan.join !== undefined) meta.set('joins', JSON.stringify([...joins(), plan.join]));
			else store.run("DELETE FROM meta WHERE key = 'joins'");
			for (const commit of plan.commits)
				store.run('INSERT INTO flushes (oid, tree, through, message) VALUES (?, ?, ?, ?)', [commit.oid, commit.tree, plan.through, commit.message]);
			store.run("UPDATE journal SET state = 'completed' WHERE n = ?", [n]);
		});
	}

	async function resume(): Promise<FlushResult> {
		const row = first<{ n: number; state: string; plan: string }>(store, 'SELECT n, state, plan FROM journal ORDER BY n LIMIT 1');
		if (row === undefined) return { kind: 'nothing' };
		const plan = JSON.parse(row.plan) as Plan;
		const tip = plan.commits.at(-1)?.oid as string;
		if (row.state !== 'completed') {
			const main = await git.readRef(MAIN);
			if (main !== tip) {
				if (main !== plan.expected) {
					store.run("UPDATE journal SET state = 'diverged' WHERE n = ? AND state <> 'completed'", [row.n]);
					return { kind: 'diverged', main, expected: plan.expected };
				}
				if (row.state === 'intended') {
					await stage(plan);
					faults?.('staging-pushed');
					store.run("UPDATE journal SET state = 'staged' WHERE n = ? AND state = 'intended'", [row.n]);
					faults?.('staged');
				}
				if (!(await git.updateRef(MAIN, tip, plan.expected))) {
					const now = await git.readRef(MAIN);
					if (now !== tip) {
						store.run("UPDATE journal SET state = 'diverged' WHERE n = ? AND state <> 'completed'", [row.n]);
						return { kind: 'diverged', main: now, expected: plan.expected };
					}
				}
				faults?.('main-moved');
			}
			complete(row.n, plan);
			faults?.('completed');
		}
		if (!(await git.deleteRef(plan.staging, tip))) throw new Error(`the staging ref ${plan.staging} moved`);
		faults?.('staging-deleted');
		store.run('DELETE FROM journal WHERE n = ?', [row.n]);
		return {
			kind: 'flushed',
			head: tip,
			commits: plan.commits.map((commit) => ({ oid: commit.oid, message: commit.message, author: commit.author.name })),
		};
	}

	async function run(): Promise<FlushResult> {
		let earlier: FlushResult = { kind: 'nothing' };
		if (first(store, 'SELECT 1 FROM journal LIMIT 1') !== undefined) {
			const stuck = first<{ n: number; plan: string }>(store, "SELECT n, plan FROM journal WHERE state = 'diverged'");
			if (stuck !== undefined) {
				const plan = JSON.parse(stuck.plan) as Plan;
				const main = await git.readRef(MAIN);
				// Put back by an operator: carry on from the start (staging is idempotent).
				if (main !== plan.expected && main !== plan.commits.at(-1)?.oid) return { kind: 'diverged', main, expected: plan.expected };
				store.run("UPDATE journal SET state = 'intended' WHERE n = ?", [stuck.n]);
			}
			earlier = await resume();
			if (earlier.kind === 'diverged') return earlier;
		}
		const intended = store.transaction(() => {
			const next = plan();
			if (next !== null) store.run("INSERT INTO journal (state, plan) VALUES ('intended', ?)", [JSON.stringify(next)]);
			return next;
		});
		if (intended === null) return earlier;
		faults?.('intended');
		const now = await resume();
		if (now.kind !== 'flushed' || earlier.kind !== 'flushed') return now;
		return { ...now, commits: [...earlier.commits, ...now.commits] };
	}

	return {
		/** Finish any interrupted flush, then flush what is new. */
		flush: () => exclusive(run),
		/**
		 * Journal a pushed commit already in Git, inside the transaction that
		 * applies its live commit: Git's `main` goes from `old` to `next` and
		 * then holds live history through place `through`. `staging` already
		 * points at `next`.
		 */
		journalPushed({ old, next, tree, through, staging, user, at, join }: { old: string | null; next: string; tree: string; through: number; staging: string; user: string; at: number; join?: Join }) {
			const commit: Planned = { oid: next, tree, parents: old === null ? [] : [old], message: 'git push\n', author: signatureOf(user), at, blobs: [], trees: [] };
			const plan: Plan = { expected: old, staging, through, commits: [commit], ...(join === undefined ? {} : { join }) };
			store.run("INSERT INTO journal (state, plan) VALUES ('staged', ?)", [JSON.stringify(plan)]);
		},
		/** Finish the journal row in place: for the receiver, which already runs exclusively. */
		finish: resume,
		/** Finish any journal row, then flush what is new, in place: for the receiver. */
		flushHere: run,
		joins,
		/** The row a diverged flush stopped at: what Git's `main` was expected to be. */
		diverged: () => {
			const row = first<{ plan: string }>(store, "SELECT plan FROM journal WHERE state = 'diverged'");
			return row === undefined ? null : { expected: (JSON.parse(row.plan) as Plan).expected };
		},
		/** Run `fn` with no flush in progress (a Git push). */
		exclusive,
		/** Resolves once nothing queued is left. */
		idle: async () => {
			await queue;
		},
	};
}
export type Flusher = ReturnType<typeof createFlusher>;
