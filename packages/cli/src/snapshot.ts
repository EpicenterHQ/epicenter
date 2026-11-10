/**
 * An app's history is commits, each with a boundary its writer knew
 * (ADR-0850).
 *
 * A call's commit holds exactly the paths its run wrote, among those that
 * changed, and nothing else pending in the folder; the call makes it itself,
 * still holding the app's lock (`run.ts`). A snapshot with no call commits
 * everything pending in the folder: `epicenter sync` before it pushes (with
 * `--message`, for an agent naming its own edits), `epicenter undo` before it
 * reverts, `epicenter update` before it merges, and `serve`'s backup clock.
 * It holds the app's lock while it commits, so it never takes part of what a
 * running call has written, from any process.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isLocalPath } from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { checkedGit, git, gitMessage, originOf } from './git.ts';
import { hold, LOCK_WAIT_MS } from './lock.ts';

/** The write run that led to a commit: its call, the paths it wrote through `folder`, and whether it threw. */
export type Wrote = { call: string; paths: string[]; threw?: true };

/** Git state that must finish before a snapshot may stage or commit. */
const UNDERWAY = [
	'MERGE_HEAD',
	'REVERT_HEAD',
	'CHERRY_PICK_HEAD',
	'rebase-merge',
	'rebase-apply',
	'sequencer',
];

/** Whether Git is in the middle of a merge, rebase, revert, or cherry-pick. */
export async function underway(folder: string) {
	const paths = await checkedGit(folder, [
		'rev-parse',
		...UNDERWAY.flatMap((path) => ['--git-path', path]),
	]);
	return paths.split('\n').some((path) => existsSync(resolve(folder, path)));
}

/**
 * What a commit did: the commit it made, nothing (nothing it would take had
 * changed, or the folder is in no repository), or why it failed and, when one
 * is known, the command that resolves it; `busy` when a snapshot with no call
 * took nothing because a call was still writing the app.
 */
export type Snapshot =
	| { committed: { subject: string; files: number } }
	| { committed: null }
	| { failed: { message: string; next?: string; busy?: true } };

/** What a snapshot with no call takes: everything in the folder that Git does not ignore. */
const TAKEN = ['.'];

/** Refused before staging when committing would store whole files that `.gitattributes` routes through LFS (ADR-0856). */
const LFS_MISSING = {
	message:
		'.gitattributes routes files through Git LFS, and this computer has no LFS filter, so Git would store them whole',
	next: 'git lfs install',
};

/** How long a commit waits for someone else's hold on Git's index lock before giving up. */
const INDEX_LOCK_WAIT_MS = 2_000;

/**
 * Git with pathspec magic (`:(literal)`, `:(top)`), retried while
 * another Git process holds `index.lock`, so a commit that meets an editor's
 * or agent's `git add` waits its turn; after about 2 seconds it throws Git's
 * message.
 */
async function gitWaitingForIndex(folder: string, args: string[]) {
	const deadline = Date.now() + INDEX_LOCK_WAIT_MS;
	for (;;) {
		const result = await git(folder, args, true);
		if (result.code === 0) return result.stdout;
		if (!result.stderr.includes('index.lock') || Date.now() > deadline)
			throw new Error(gitMessage(args, result));
		await Bun.sleep(50);
	}
}

/** `git status --porcelain -z` arguments for `pathspec`: every untracked file, no renames, so each entry is one path. */
const statusArgs = (pathspec: string[]) => [
	'status',
	'--porcelain',
	'-z',
	'--untracked-files=all',
	'--no-renames',
	'--',
	...pathspec,
];

/** The entries in `git status --porcelain -z` output: each one's `XY` code, and its path relative to the repository's top. */
const statusEntries = (status: string) =>
	status
		.split('\0')
		.filter(Boolean)
		.map((entry) => ({ code: entry.slice(0, 2), path: entry.slice(3) }));

/** The paths in `git status --porcelain -z` output, relative to the repository's top. */
const statusPaths = (status: string) =>
	statusEntries(status).map((entry) => entry.path);

/** A commit refused before staging, with the command that resolves it. */
class Refused extends Error {
	constructor(
		message: string,
		readonly next?: string,
	) {
		super(message);
	}
}

/**
 * Throws, before anything is staged, when `status` holds a `.local` path, one
 * that stays on this computer (a token, a device's settings, a write's
 * temporary file), naming the first as a path in the app's folder. The app's
 * `.gitignore` keeps them out of every Git tool's commits; a commit here only
 * checks, and refuses to take one the ignore file let through. An untracked
 * one needs the ignore file's lines; one Git already tracks needs removing
 * from the index, which the ignore file cannot do, and a commit of that.
 */
async function refuseLocal(app: string, folder: string, status: string) {
	const local = statusEntries(status).find((entry) => isLocalPath(entry.path));
	if (local === undefined) return;
	const prefix = (await git(folder, ['rev-parse', '--show-prefix'])).stdout;
	const inFolder = local.path.startsWith(prefix)
		? local.path.slice(prefix.length)
		: local.path;
	if (local.code === '??')
		throw new Refused(
			`${inFolder} would be committed; add *.local and *.local.* to ${app}/.gitignore`,
		);
	// A commit of named paths takes a file's bytes from the folder even once
	// it is out of the index, so its removal is committed by Git alone.
	const commit = `git -C ${folder} commit -m "${app}: stop tracking ${inFolder}"`;
	throw new Refused(
		`${inFolder} would be committed: Git already tracks it, so ${app}/.gitignore cannot keep it out`,
		local.code.startsWith('D')
			? commit
			: `git -C ${folder} rm --cached -- ${inFolder} && ${commit}`,
	);
}

/**
 * What Git says is pending and, when the branch has an `origin` tracking ref,
 * how many commits are not yet backed up; `undefined` for a folder in no
 * repository.
 */
export async function statusOf(folder: string) {
	const status = await git(folder, statusArgs(TAKEN), true);
	if (status.code !== 0) return undefined;
	const unpushed = (await originOf(folder))?.ahead;
	return {
		pending: statusPaths(status.stdout).length,
		...(unpushed === undefined ? {} : { unpushed }),
	};
}

/**
 * Commit exactly the paths `wrote` reports that have changed, named for its
 * call: one `git status` of those paths drops what is unchanged, ignored, or
 * created and then deleted; `git add -A` and `git commit` of what is left
 * leave every other pending or staged change as it was. `null` when none
 * changed.
 */
async function commitCall(app: string, folder: string, wrote: Wrote) {
	if (wrote.paths.length === 0) return null;
	const subject = wrote.threw ? `${wrote.call} (threw)` : wrote.call;
	const written = wrote.paths.map((path) => `:(literal)${path}`);
	const status = await gitWaitingForIndex(folder, statusArgs(written));
	const paths = statusPaths(status);
	if (paths.length === 0) return null;
	await refuseLocal(app, folder, status);
	const changed = paths.map((path) => `:(top,literal)${path}`);
	await gitWaitingForIndex(folder, ['add', '-A', '--', ...changed]);
	await gitWaitingForIndex(folder, [
		'commit',
		'-q',
		'-m',
		subject,
		'--',
		...changed,
	]);
	return { subject, files: changed.length };
}

/** Stage and commit everything pending, as `<app>: <message>`; `null` when nothing was. */
async function commitPending(app: string, folder: string, message: string) {
	await refuseLocal(
		app,
		folder,
		await gitWaitingForIndex(folder, statusArgs(TAKEN)),
	);
	await gitWaitingForIndex(folder, ['add', '-A', '--', ...TAKEN]);
	const staged = await gitWaitingForIndex(folder, [
		'diff',
		'--cached',
		'--name-only',
		'--relative',
		'--no-renames',
		'-z',
		'--',
		...TAKEN,
	]);
	const files = staged.split('\0').filter(Boolean).length;
	if (files === 0) return null;
	const subject = `${app}: ${message}`;
	await gitWaitingForIndex(folder, [
		'commit',
		'-q',
		'-m',
		subject,
		'--',
		...TAKEN,
	]);
	return { subject, files };
}

/**
 * Whose boundary a commit has: a call's, which takes only the paths it
 * wrote and is made holding the app's lock, or none, which takes everything
 * pending under `message` (default `changed outside epicenter`) once it holds
 * the lock, waiting up to `wait` milliseconds for a call to finish (30
 * seconds unless given; 0 tries once).
 */
export type Boundary = { wrote: Wrote } | { message?: string; wait?: number };

/** Commit in `folder`, which is in a repository. */
async function take(
	app: string,
	folder: string,
	boundary: Boundary,
): Promise<Snapshot> {
	try {
		if (await underway(folder))
			return {
				failed: {
					message:
						'the repository is in the middle of a merge, rebase, revert, or cherry-pick; finish or abort it first',
					next: `git -C ${folder} status`,
				},
			};
		const attributes = await readFile(
			join(folder, '.gitattributes'),
			'utf8',
		).catch(() => '');
		if (
			attributes.includes('filter=lfs') &&
			(await git(folder, ['config', '--get', 'filter.lfs.process'])).stdout ===
				''
		)
			return { failed: LFS_MISSING };
		return {
			committed:
				'wrote' in boundary
					? await commitCall(app, folder, boundary.wrote)
					: await commitPending(
							app,
							folder,
							boundary.message ?? 'changed outside epicenter',
						),
		};
	} catch (error) {
		return {
			failed: {
				message: extractErrorMessage(error),
				...(error instanceof Refused && error.next ? { next: error.next } : {}),
			},
		};
	}
}

/**
 * Commit in the app's folder (ADR-0850): with `{ wrote }`, exactly the
 * call's changed paths, named for the call (`<call> (threw)` when it threw),
 * with no body; otherwise everything pending that Git does not ignore, as
 * `<app>: changed outside epicenter` or `<app>: <message>`, holding the app's
 * lock, or `busy` when a call still held it after the wait.
 * Refused before staging when what it would take holds a `*.local` or
 * `*.local.*` file, when `.gitattributes` routes files through LFS and this
 * computer has no filter, or when a Git operation is underway. Never throws:
 * a failure is returned to the caller.
 */
export async function snapshot(
	app: string,
	folder: string,
	boundary: Boundary = {},
): Promise<Snapshot> {
	try {
		if (
			(await git(folder, ['rev-parse', '--is-inside-work-tree'])).stdout !==
			'true'
		)
			return { committed: null };
		if ('wrote' in boundary) return await take(app, folder, boundary);
		const alone = await hold(folder, boundary.wait ?? LOCK_WAIT_MS);
		if (!alone)
			return {
				failed: { message: `a call is still writing ${app}`, busy: true },
			};
		try {
			return await take(app, folder, boundary);
		} finally {
			alone.release();
		}
	} catch (error) {
		return { failed: { message: extractErrorMessage(error) } };
	}
}
