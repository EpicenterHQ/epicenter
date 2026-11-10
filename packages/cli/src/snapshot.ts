/**
 * An app's history is commits, each with a boundary its writer knew
 * (ADR-0850). A run never commits; whoever started it commits for it.
 *
 * A call's commit holds exactly the paths the run reported writing, among
 * those that changed, and nothing else pending in the folder: the command
 * line commits after a write run it ran itself, and `serve` after each write
 * call. A snapshot with no call commits everything pending in the folder:
 * `epicenter sync` before it pushes (with `--message`, for an agent naming
 * its own edits), `epicenter undo` before it reverts, `epicenter update`
 * before it merges, and `serve`'s backup clock.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isLocalPath } from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { checkedGit, git, gitMessage, originOf } from './git.ts';

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

/** What a commit did: the commit it made, nothing (nothing it would take had changed, or the folder is in no repository), or why it failed and, when one is known, the command that resolves it. */
export type Snapshot =
	| { committed: { subject: string; files: number } }
	| { committed: null }
	| { failed: { message: string; next?: string } };

/** What a snapshot with no call takes: everything in the folder that Git does not ignore. */
const TAKEN = ['.'];

/** Refused before staging when committing would store whole files that `.gitattributes` routes through LFS (ADR-0856). */
const LFS_MISSING = {
	message:
		'.gitattributes routes files through Git LFS, and this computer has no LFS filter, so Git would store them whole',
	next: 'git lfs install',
};

/**
 * How many times a commit looks again at what is pending after its `git
 * commit` failed. Each failure means another process committed meanwhile,
 * so a later look may find nothing left to take.
 */
const COMMIT_TRIES = 5;

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

/** The paths in `git status --porcelain -z` output, relative to the repository's top. */
const statusPaths = (status: string) =>
	status
		.split('\0')
		.filter(Boolean)
		.map((entry) => entry.slice(3));

/**
 * Throws, before anything is staged, when `paths` (relative to the
 * repository's top) hold a `.local` path, one that stays on this computer (a
 * token, a device's settings, a write's temporary file), naming the first as
 * a path in the app's folder. The app's `.gitignore` keeps them out of every
 * Git tool's commits; a commit here only checks, and refuses to take one the
 * ignore file let through.
 */
async function refuseLocal(app: string, folder: string, paths: string[]) {
	const local = paths.find(isLocalPath);
	if (local === undefined) return;
	const prefix = (await git(folder, ['rev-parse', '--show-prefix'])).stdout;
	const inFolder = local.startsWith(prefix)
		? local.slice(prefix.length)
		: local;
	throw new Error(
		`${inFolder} would be committed; add *.local and *.local.* to ${app}/.gitignore`,
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
	for (let tries = 1; ; tries++) {
		const paths = statusPaths(
			await gitWaitingForIndex(folder, statusArgs(written)),
		);
		if (paths.length === 0) return null;
		await refuseLocal(app, folder, paths);
		const changed = paths.map((path) => `:(top,literal)${path}`);
		await gitWaitingForIndex(folder, ['add', '-A', '--', ...changed]);
		try {
			await gitWaitingForIndex(folder, [
				'commit',
				'-q',
				'-m',
				subject,
				'--',
				...changed,
			]);
			return { subject, files: changed.length };
		} catch (error) {
			// Another process may have committed these paths meanwhile: look again.
			if (tries === COMMIT_TRIES) throw error;
		}
	}
}

/** Stage and commit everything pending, as `<app>: <message>`; `null` when nothing was. */
async function commitPending(app: string, folder: string, message: string) {
	for (let tries = 1; ; tries++) {
		await refuseLocal(
			app,
			folder,
			statusPaths(await gitWaitingForIndex(folder, statusArgs(TAKEN))),
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
		try {
			await gitWaitingForIndex(folder, [
				'commit',
				'-q',
				'-m',
				subject,
				'--',
				...TAKEN,
			]);
			return { subject, files };
		} catch (error) {
			// Another process's snapshot may have committed what this one staged: look again.
			if (tries === COMMIT_TRIES) throw error;
		}
	}
}

/**
 * Whose boundary a commit has: a call's, which takes only the paths it
 * wrote, or none, which takes everything pending under `message` (default
 * `changed outside epicenter`).
 */
export type Boundary = { wrote: Wrote } | { message?: string };

async function take(
	app: string,
	folder: string,
	boundary: Boundary,
): Promise<Snapshot> {
	if (
		(await git(folder, ['rev-parse', '--is-inside-work-tree'])).stdout !==
		'true'
	)
		return { committed: null };
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
		return { failed: { message: extractErrorMessage(error) } };
	}
}

/** The commit running or waiting for each folder, so this process makes one at a time per app. */
const queued = new Map<string, Promise<Snapshot>>();

/**
 * Commit in the app's folder (ADR-0850): with `{ wrote }`, exactly the
 * call's changed paths, named for the call (`<call> (threw)` when it threw),
 * with no body; otherwise everything pending that Git does not ignore, as
 * `<app>: changed outside epicenter` or `<app>: <message>`. Refused before staging when what it would take holds a
 * `*.local` or `*.local.*` file, when `.gitattributes` routes files through
 * LFS and this computer has no filter, or when a Git operation is underway.
 * Never throws: a failure is returned to the caller.
 */
export function snapshot(
	app: string,
	folder: string,
	boundary: Boundary = {},
): Promise<Snapshot> {
	const next = (queued.get(folder) ?? Promise.resolve())
		.then(() => take(app, folder, boundary))
		.catch(
			(error): Snapshot => ({
				failed: { message: extractErrorMessage(error) },
			}),
		);
	queued.set(folder, next);
	void next.then(() => {
		if (queued.get(folder) === next) queued.delete(folder);
	});
	return next;
}
