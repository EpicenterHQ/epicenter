/**
 * One round of `epicenter sync` for one registered data folder, over the
 * system `git` (decisions 21, 31, 33, 41, 44, 52):
 *
 *   guards -> git add -A -- <folder> -> commit the folder's paths
 *   -> fetch -> checks (rewrite, index lock) -> merge origin/main
 *   -> edit beats delete, binary conflict copies -> git lfs push -> push
 *   (a rejected push fetches, merges, and pushes again)
 *
 * Epicenter sync is the only desktop committer (decision 31), and it commits
 * only the data folder's own paths, never the rest of an enclosing
 * repository; fetch, merge, and push are repository-wide. Rounds are
 * serialized per repository by a lock file in its Git directory, so the
 * desktop app's `--watch` and a person's `epicenter sync` take turns.
 *
 * It never calls `git pull`: the rewrite check (decision 33) needs the
 * fetched remote before any merge. `refs/epicenter/last-seen` names the
 * remote `main` this clone last merged or pushed; a remote `main` that no
 * longer contains it was rewritten, and sync stops rather than push the
 * replaced history back.
 *
 * A round ends `synced`, `retry` (transient: a lock another program holds,
 * the network, a push still rejected after every attempt; run it again), or
 * `stopped` (a person or agent must act: a merge in progress, a rewrite,
 * conflicts Epicenter does not settle, a clone not set up).
 */

import { existsSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
	conflictSibling,
	lfsOid,
	parsePointer,
} from '@epicenter/definition/merge';
import { holdingFileLock } from '@epicenter/folder/bun';
import { resolveAppPaths } from '../app-paths.ts';
import {
	config,
	type GitOptions,
	git,
	must,
	type RemoteCredential,
} from './git.ts';
import { driverCommand, identity, repositoryRoot } from './setup.ts';

const LAST_SEEN = 'refs/epicenter/last-seen';
const REMOTE_MAIN = 'refs/remotes/origin/main';
/**
 * What a failed `git push` means for the round.
 *
 * - `moved`: the remote moved first (not a fast-forward, or a lost race on the
 *   ref update); fetch, merge, and push again.
 * - `refused`: the remote's policy turned the push down (a raw file where an
 *   LFS pointer belongs, a ref other than `main`). Pushing again cannot help,
 *   so the round stops for a person or an agent.
 * - `failed`: anything else, such as the network; run the round again later.
 */
export function classifyPush(stderr: string): 'moved' | 'refused' | 'failed' {
	if (
		/\[rejected\]|non-fast-forward|fetch first|cannot lock ref|failed to update ref|stale/.test(
			stderr,
		)
	)
		return 'moved';
	if (/\[remote rejected\]|pre-receive hook declined/.test(stderr))
		return 'refused';
	return 'failed';
}

/** Fetch, merge, and push attempts in one round before a rejected push is a `retry`. */
const ATTEMPTS = 5;
/** How long a round waits for another round in the same repository. */
const TURN_WAIT_MS = 120_000;

export type SyncStatus = 'synced' | 'retry' | 'stopped';

export type SyncResult = {
	readonly folder: string;
	readonly status: SyncStatus;
	/** The commit the folder's repository is at when the round ends. */
	readonly head?: string;
	/** What the round did, one line each, in order. */
	readonly notes: string[];
	/** Why the round ended `retry` or `stopped`. */
	readonly message?: string;
};

export type SyncOptions = {
	/** The credential for the remote, asked for by its URL. */
	readonly credential?: (url: string) => Promise<RemoteCredential | undefined>;
};

class Stop extends Error {
	constructor(
		message: string,
		readonly status: 'retry' | 'stopped',
	) {
		super(message);
	}
}

/** Run one sync round for the folder at `input`. Never throws for a stop. */
export async function syncFolder(
	input: string,
	options: SyncOptions = {},
): Promise<SyncResult> {
	const notes: string[] = [];
	let folder = resolve(input);
	try {
		if (!existsSync(folder) || !statSync(folder).isDirectory())
			throw new Stop(
				`${folder} does not exist. Run epicenter forget ${folder} if it is gone for good.`,
				'stopped',
			);
		folder = await realpath(folder);
		const root = await repositoryRoot(folder);
		if (root === null)
			throw new Stop(
				`${folder} is not in a Git repository. Run epicenter init ${folder}.`,
				'stopped',
			);
		// Only a repository init adopted: otherwise a folder inside some other
		// repository (a home or dotfiles one) would have it pulled and pushed.
		if ((await config(folder, 'epicenter.root')) !== root)
			throw new Stop(
				`the repository at ${root} was not set up by epicenter init (or was forgotten), so nothing was committed. Run epicenter init ${folder}.`,
				'stopped',
			);
		const common = resolve(
			folder,
			(await must(folder, ['rev-parse', '--git-common-dir'])).trim(),
		);
		const head = await holdingFileLock(
			join(common, 'epicenter-sync.lock'),
			{
				waitMs: TURN_WAIT_MS,
				held: `another epicenter sync of ${root} ran for more than ${TURN_WAIT_MS / 1000} seconds; nothing was changed.`,
			},
			() => round(folder, root, options, notes),
		).catch((cause: unknown) => {
			if (cause instanceof Stop) throw cause;
			// The lock could not be taken: another round is still running.
			if (cause instanceof Error && cause.name === 'NothingChanged')
				throw new Stop(cause.message, 'retry');
			throw cause;
		});
		return { folder, status: 'synced', head, notes };
	} catch (cause) {
		if (!(cause instanceof Stop)) throw cause;
		const head = await git(folder, [
			'rev-parse',
			'-q',
			'--verify',
			'HEAD',
		]).catch(() => undefined);
		return {
			folder,
			status: cause.status,
			...(head?.code === 0 ? { head: head.stdout.trim() } : {}),
			notes,
			message: cause.message,
		};
	}
}

const has = async (cwd: string, ref: string) =>
	(await git(cwd, ['rev-parse', '-q', '--verify', `${ref}^{commit}`])).code ===
	0;
const sha = async (cwd: string, ref: string) =>
	(await must(cwd, ['rev-parse', ref])).trim();

/** The index lock's path, and how long ago it was taken when another program holds it. */
async function indexLock(cwd: string): Promise<string | null> {
	const path = resolve(
		cwd,
		(await must(cwd, ['rev-parse', '--git-path', 'index.lock'])).trim(),
	);
	if (!existsSync(path)) return null;
	const age = Math.round((Date.now() - statSync(path).mtimeMs) / 1000);
	return `another program holds ${path} (taken ${age}s ago); nothing was changed. Run sync again; if it is still there and no git is running, delete it.`;
}

async function refuseIfLocked(cwd: string) {
	const locked = await indexLock(cwd);
	if (locked !== null) throw new Stop(locked, 'retry');
}

type Stage = { mode: string; sha: string };

/** Unmerged index entries by path (relative to `root`): stage 1 base, 2 ours, 3 theirs. */
async function unmerged(root: string) {
	const byPath = new Map<string, Map<number, Stage>>();
	for (const entry of (await must(root, ['ls-files', '-u', '-z']))
		.split('\0')
		.filter(Boolean)) {
		const tab = entry.indexOf('\t');
		const [mode = '', blob = '', stage = ''] = entry.slice(0, tab).split(' ');
		const path = entry.slice(tab + 1);
		const stages = byPath.get(path) ?? new Map<number, Stage>();
		stages.set(Number(stage), { mode, sha: blob });
		byPath.set(path, stages);
	}
	return byPath;
}

/** A git step that must succeed: a lock makes it a `retry`, anything else a `stop`. */
async function step(
	cwd: string,
	args: readonly string[],
	what: string,
	options: GitOptions = {},
) {
	const ran = await git(cwd, args, options);
	if (ran.code === 0) return ran.stdout;
	const locked = await indexLock(cwd);
	throw new Stop(
		locked ?? `${what} failed: ${ran.stderr.trim()}`,
		locked === null ? 'stopped' : 'retry',
	);
}

/** Paths are literal: a file named `*.md` names only itself. */
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };

/** The round itself, holding the repository's sync lock. Returns the head it ends at. */
async function round(
	folder: string,
	root: string,
	{ credential }: SyncOptions,
	notes: string[],
): Promise<string> {
	// Never commit over an unfinished merge, rebase, or unmerged entries.
	for (const state of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'])
		if (await has(root, state))
			throw new Stop(
				`${state} exists: a merge is in progress. Finish or abort it, then sync.`,
				'stopped',
			);
	for (const name of ['rebase-merge', 'rebase-apply'])
		if (
			existsSync(
				resolve(
					root,
					(await must(root, ['rev-parse', '--git-path', name])).trim(),
				),
			)
		)
			throw new Stop(
				'a rebase is in progress. Finish or abort it, then sync.',
				'stopped',
			);
	const conflicted = await unmerged(root);
	if (conflicted.size > 0)
		throw new Stop(
			`unmerged entries exist (${[...conflicted.keys()].join(', ')}). Resolve them, then sync.`,
			'stopped',
		);
	// Without the driver and the LFS filters, git add would store raw bytes and notes would merge by line.
	if (
		(await config(folder, 'merge.epicenter.driver')) !== driverCommand() ||
		(await config(folder, 'filter.lfs.process')) === null
	)
		throw new Stop(
			`this clone is not set up (merge driver or LFS filters missing). Run epicenter init ${folder}, then sync.`,
			'stopped',
		);
	if (!existsSync(resolveAppPaths().commandLink))
		throw new Stop(
			`${resolveAppPaths().commandLink}, the merge driver's command, is missing. Run epicenter install-command, then sync.`,
			'stopped',
		);
	if ((await git(root, ['symbolic-ref', '-q', 'HEAD'])).code !== 0)
		throw new Stop(
			'HEAD is detached. Check out a branch, then sync.',
			'stopped',
		);
	await refuseIfLocked(root);

	// Commit what the apps wrote in this folder, through the filters, and nothing else.
	const who = await identity(root);
	await step(folder, ['add', '-A', '--', '.'], 'git add');
	if (
		(await git(folder, ['diff', '--cached', '--quiet', '--', '.'])).code !== 0
	) {
		await step(
			folder,
			[
				'commit',
				'-q',
				'-m',
				`epicenter sync ${new Date().toISOString()}`,
				'--',
				'.',
			],
			'git commit',
			{ env: who },
		);
		notes.push('committed local changes');
	}

	const url = await config(root, 'remote.origin.url');
	if (url === null) {
		notes.push('no remote: committed locally');
		return sha(root, 'HEAD');
	}
	const auth = await credential?.(url);
	for (let attempt = 1; ; attempt++) {
		const fetched = await git(root, ['fetch', '-q', 'origin'], {
			credential: auth,
		});
		if (fetched.code !== 0)
			throw new Stop(`git fetch failed: ${fetched.stderr.trim()}`, 'retry');
		if (await has(root, REMOTE_MAIN)) await mergeRemote(root, auth, who, notes);
		if (
			(await has(root, REMOTE_MAIN)) &&
			(await sha(root, 'HEAD')) === (await sha(root, REMOTE_MAIN))
		)
			return sha(root, 'HEAD');

		const uploaded = await git(root, ['lfs', 'push', 'origin', 'HEAD'], {
			credential: auth,
		});
		if (uploaded.code !== 0)
			throw new Stop(`git lfs push failed: ${uploaded.stderr.trim()}`, 'retry');
		const pushed = await git(
			root,
			['push', '-q', 'origin', 'HEAD:refs/heads/main'],
			{ credential: auth },
		);
		if (pushed.code === 0) {
			const at = await sha(root, 'HEAD');
			await must(root, ['update-ref', REMOTE_MAIN, at]);
			await must(root, ['update-ref', LAST_SEEN, at]);
			notes.push(`pushed ${at.slice(0, 7)}`);
			return at;
		}
		const outcome = classifyPush(pushed.stderr);
		if (outcome === 'refused')
			throw new Stop(
				`the remote refused the push: ${pushed.stderr.trim()}`,
				'stopped',
			);
		if (outcome === 'failed')
			throw new Stop(`git push failed: ${pushed.stderr.trim()}`, 'retry');
		if (attempt >= ATTEMPTS)
			throw new Stop(
				`the remote moved during each of ${ATTEMPTS} pushes; nothing was lost. Run sync again.`,
				'retry',
			);
		notes.push('push rejected: the remote moved; fetching again');
	}
}

/** Check, then merge the fetched remote main, settling what Git leaves unmerged. */
async function mergeRemote(
	root: string,
	auth: RemoteCredential | undefined,
	who: Record<string, string>,
	notes: string[],
) {
	const firstContact = !(await has(root, LAST_SEEN));
	// The rewrite check (decision 33): the remote main must still contain the last one this clone saw.
	if (
		!firstContact &&
		(await git(root, ['merge-base', '--is-ancestor', LAST_SEEN, REMOTE_MAIN]))
			.code !== 0
	)
		throw new Stop(
			`the remote main was rewritten: it no longer contains ${(await sha(root, LAST_SEEN)).slice(0, 7)}, the main this clone last saw ` +
				`(remote main is now ${(await sha(root, REMOTE_MAIN)).slice(0, 7)}). Not merging, so the replaced history is not pushed back. ` +
				`Move your unsynced work onto origin/main (for example: git rebase --onto origin/main ${LAST_SEEN}), then: git update-ref ${LAST_SEEN} origin/main`,
			'stopped',
		);
	await refuseIfLocked(root);
	// First contact joins two histories that each began on their own (decision 20).
	const merged = await git(
		root,
		[
			'merge',
			'--no-edit',
			'-q',
			...(firstContact ? ['--allow-unrelated-histories'] : []),
			REMOTE_MAIN,
		],
		{ credential: auth, env: who },
	);
	for (const line of merged.stderr.split('\n'))
		if (line.startsWith('[epicenter merge] '))
			notes.push(line.slice('[epicenter merge] '.length));
	if (merged.code !== 0) {
		if (!(await has(root, 'MERGE_HEAD'))) {
			const locked = await indexLock(root);
			if (locked !== null) throw new Stop(locked, 'retry');
			// An app saved a file the merge would overwrite after this round committed: the next round commits it.
			if (/would be overwritten/.test(merged.stderr))
				throw new Stop(
					`git merge refused: a file changed during sync. Run sync again.\n  ${merged.stderr.trim()}`,
					'retry',
				);
			throw new Stop(
				`git merge refused before starting:\n  ${merged.stderr.trim()}`,
				'stopped',
			);
		}
		await settleUnmerged(root, auth, notes);
		await step(root, ['commit', '-q', '--no-edit'], 'git commit (merge)', {
			env: who,
		});
	}
	await must(root, ['update-ref', LAST_SEEN, REMOTE_MAIN]);
	notes.push(
		`merged origin/main ${(await sha(root, REMOTE_MAIN)).slice(0, 7)}`,
	);
}

/**
 * What the merge driver cannot settle, by the server's rules: an edit beats
 * a delete, keeping the side that edited; a file both sides replaced or
 * created that is not a note keeps the remote's (the earlier arrival) at its
 * path and lands the local one beside it as `<stem> (conflict <hash7>)<ext>`
 * (decision 44). Anything else stops with Git's conflict state in place.
 */
async function settleUnmerged(
	root: string,
	auth: RemoteCredential | undefined,
	notes: string[],
) {
	const left: string[] = [];
	const literal = { env: LITERAL, credential: auth };
	for (const [path, stages] of await unmerged(root)) {
		const base = stages.has(1);
		const ours = stages.get(2);
		const theirs = stages.get(3);
		if (base && ours !== undefined && theirs === undefined) {
			await step(
				root,
				['checkout', '--ours', '--', path],
				`keep the local edit of ${path}`,
				literal,
			);
			await step(root, ['add', '--', path], `stage ${path}`, literal);
			notes.push(`edit beats delete: kept ${path} (local edit)`);
		} else if (base && theirs !== undefined && ours === undefined) {
			await step(
				root,
				['checkout', '--theirs', '--', path],
				`keep the remote edit of ${path}`,
				literal,
			);
			await step(root, ['add', '--', path], `stage ${path}`, literal);
			notes.push(`edit beats delete: kept ${path} (remote edit)`);
		} else if (
			ours !== undefined &&
			theirs !== undefined &&
			!path.endsWith('.md')
		) {
			const blob = await git(root, ['cat-file', 'blob', ours.sha]);
			const oid = parsePointer(blob.stdout)?.oid ?? (await lfsOid(blob.bytes));
			const sibling = conflictSibling(path, oid);
			await step(
				root,
				[
					'update-index',
					'--add',
					'--cacheinfo',
					`${ours.mode},${ours.sha},${sibling}`,
				],
				`stage ${sibling}`,
				literal,
			);
			await step(
				root,
				['checkout', '--theirs', '--', path],
				`keep the remote ${path}`,
				literal,
			);
			await step(root, ['add', '--', path], `stage ${path}`, literal);
			await step(
				root,
				['checkout', '--', sibling],
				`write ${sibling}`,
				literal,
			);
			notes.push(`conflict copy: ${sibling}`);
		} else left.push(path);
	}
	if (left.length > 0)
		throw new Stop(
			`the merge left conflicts Epicenter does not settle: ${left.join(', ')}. Git's conflict state is in place; resolve and commit, then sync.`,
			'stopped',
		);
}
