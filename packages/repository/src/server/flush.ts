/**
 * The flush state machine: live history into real Git commits, recoverable
 * after a crash at any step (deployed spike 3 proved this design against
 * Artifacts at every step boundary, with duplicate and concurrent runs).
 *
 * 1. Intent (one Store transaction): plan the Git commits from the last
 *    flush to `main` (one at each merge that wrote a conflict block, so the
 *    value that lost is in Git history, then one at `main`), with their
 *    trees, messages and ids computed here, and the Git `main` expected.
 * 2. Stage: write the blobs, trees and commits, check each id is the one
 *    planned, and point a staging ref at the tip.
 * 3. Compare-and-swap `main` from the expected commit to the tip.
 * 4. Complete (one transaction): record Git's head and how far it holds
 *    live history.
 * 5. Prune: delete the staging ref, then the journal row.
 *
 * Every run starts by finishing a journal row a crash left, reading Git's
 * `main` first: at the tip, the swap happened (record it); at the expected
 * commit, carry on from the recorded step; anywhere else, something outside
 * moved `main`, and the flush stops as `diverged`, its intent kept.
 *
 * Every Git commit's tree holds Epicenter's `.gitattributes`.
 */
import { ATTRIBUTES } from '../core/door.js';
import { gitCommitHash } from '../core/hash.js';
import { first, type SqlDriver } from '../sql.js';
import { type GitObjects, MAIN, type Signature, type Tree } from './git-store.js';
import type { History } from './history.js';

/** A step boundary, where a crash can stop a flush (named for what has just happened). */
export type FlushStep = 'intended' | 'staging-pushed' | 'staged' | 'main-moved' | 'completed' | 'staging-deleted';

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
};

type Plan = { expected: string | null; staging: string; through: number; commits: Planned[] };

export const COMMITTER: Signature = { name: 'Epicenter', email: 'epicenter@users.epicenter.invalid' };
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

	/** The Git commits from the last flush to `main`, or null when Git already holds `main`'s content. */
	function plan(): Plan | null {
		const flushed = meta.number('flushed');
		const top = history.top();
		if (top <= flushed) return null;
		const from = Math.max(flushed + 1, history.offset());
		const cuts: number[] = [];
		for (let i = from; i <= top; i++) if (history.at(i).blocks) cuts.push(i);
		if (cuts.at(-1) !== top) cuts.push(top);
		const attributes = history.keep(ATTRIBUTES);
		let previousTree = meta.get('git_tree') ?? trees.empty;
		let previousOid = meta.get('git_head');
		const commits: Planned[] = [];
		let start = from;
		for (const end of cuts) {
			const range = Array.from({ length: end - start + 1 }, (_, k) => history.at(start + k));
			start = end + 1;
			const cut = history.at(end);
			const tree = trees.update(cut.tree, [[['.gitattributes'], attributes]]);
			if (tree === previousTree) continue;
			const changed = trees.diff(previousTree, tree);
			const paths = changed.filter((path) => path !== '.gitattributes').sort();
			const counts = new Map<string, number>();
			for (const commit of range) if (commit.author.user !== 'epicenter') counts.set(commit.author.user, (counts.get(commit.author.user) ?? 0) + 1);
			const subject = cut.blocks
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
			const author = signatureOf([...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'epicenter');
			const parents = previousOid === null || previousOid === '' ? [] : [previousOid];
			const seconds = Math.floor(cut.at / 1000);
			const oid = gitCommitHash({ tree, parents, message, author: { ...author, at: seconds }, committer: { ...COMMITTER, at: seconds } });
			const blobs = [...new Set(changed.map((path) => trees.read(tree, path)).filter((hash): hash is string => hash !== null))];
			commits.push({ oid, tree, parents, message, author, at: cut.at, blobs });
			previousTree = tree;
			previousOid = oid;
		}
		if (commits.length === 0) {
			meta.set('flushed', top);
			return null;
		}
		const n = (first<{ n: number | null }>(store, 'SELECT MAX(n) AS n FROM flushes')?.n ?? 0) + 1;
		const expected = meta.get('git_head');
		return { expected: expected === '' ? null : expected, staging: `refs/heads/epicenter-staging-${n}`, through: top, commits };
	}

	/** Every path in a tree, as Git's flat tree. */
	function flat(tree: string): Tree {
		const out: Tree = new Map();
		for (const path of trees.diff(trees.empty, tree)) out.set(path, { mode: '100644', oid: trees.read(tree, path) as string });
		return out;
	}

	async function stage(plan: Plan) {
		const tip = plan.commits.at(-1)?.oid as string;
		const staged = await git.readRef(plan.staging);
		if (staged === tip) return;
		for (const commit of plan.commits) {
			for (const hash of commit.blobs) {
				const text = history.blob(hash);
				if (text === null) throw new Error(`the flush lost the text of blob ${hash}`);
				const oid = await git.writeBlob(encoder.encode(text));
				if (oid !== hash) throw new Error(`Git wrote blob ${oid} for ${hash}`);
			}
			const tree = await git.writeTree(flat(commit.tree));
			if (tree !== commit.tree) throw new Error(`Git wrote tree ${tree} for ${commit.tree}`);
			const oid = await git.writeCommit({ tree, parents: commit.parents, message: commit.message, author: commit.author, committer: COMMITTER, at: new Date(commit.at) });
			if (oid !== commit.oid) throw new Error(`Git wrote commit ${oid} for ${commit.oid}`);
		}
		// Another run of this flush may have staged it meanwhile.
		if (!(await git.updateRef(plan.staging, tip, staged)) && (await git.readRef(plan.staging)) !== tip) throw new Error(`the staging ref ${plan.staging} moved`);
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
			if (first(store, "SELECT 1 FROM journal WHERE state = 'diverged'") !== undefined)
				return { kind: 'diverged', main: await git.readRef(MAIN), expected: meta.get('git_head') };
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
		/** Run `fn` with no flush in progress (a Git push). */
		exclusive,
		/** Resolves once nothing queued is left. */
		idle: async () => {
			await queue;
		},
	};
}
export type Flusher = ReturnType<typeof createFlusher>;
