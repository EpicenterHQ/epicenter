/**
 * An app's history is commits, each with a boundary its writer knew
 * (ADR-0850). A run never commits; whoever started it commits for it.
 *
 * A call's commit holds exactly the paths the run reported writing, among
 * those that changed, and nothing else pending in the folder: the command
 * line commits after a write run it ran itself, and `serve` after each write
 * call. A snapshot with no call commits everything pending in the folder:
 * `epicenter sync` before it pushes (with `--message`, for an agent naming
 * its own edits), `epicenter undo` before it reverts, and `serve`'s backup
 * clock.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isLocalPath } from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { git, gitMessage } from './git.ts';

/** The write run that led to a commit: its call, the paths it wrote through `folder`, and whether it threw. */
export type Wrote = { call: string; paths: string[]; threw?: true };

/** The body header for the paths of a snapshot with no call. `epicenter history` parses it. */
export const CHANGED = 'Changed:';

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
	const args = [
		'rev-parse',
		...UNDERWAY.flatMap((path) => ['--git-path', path]),
	];
	const paths = await git(folder, args);
	if (paths.code !== 0) throw new Error(gitMessage(args, paths));
	return paths.stdout
		.split('\n')
		.some((path) => existsSync(resolve(folder, path)));
}

/** What a commit did: the commit it made, nothing (nothing it would take had changed, or the folder is in no repository), or why it failed. */
export type Snapshot =
	| { committed: { subject: string; files: number } }
	| { committed: null }
	| { failed: string };

/** What a snapshot with no call takes: everything in the folder that Git does not ignore. */
const TAKEN = ['.'];

/** Refused before staging when committing would store whole files that `.gitattributes` routes through LFS (ADR-0856). */
const LFS_MISSING =
	'.gitattributes routes files through Git LFS, and this computer has no LFS filter, so Git would store them whole; run: git lfs install';

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
 * What Git says is pending and not yet backed up. A missing origin tracking
 * branch gives no unpushed count because its distance cannot be known.
 */
export async function statusOf(folder: string) {
	const status = await git(folder, statusArgs(TAKEN), true);
	if (status.code !== 0) return undefined;
	const hasOrigin =
		(await git(folder, ['remote', 'get-url', 'origin'])).code === 0;
	const branch = hasOrigin
		? (await git(folder, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout
		: '';
	const counted = branch
		? await git(folder, [
				'rev-list',
				'--count',
				`refs/remotes/origin/${branch}..HEAD`,
			])
		: undefined;
	return {
		pending: statusPaths(status.stdout).length,
		...(counted?.code === 0 ? { unpushed: Number(counted.stdout) } : {}),
	};
}

/** A path on its own line in a snapshot's body; JSON-quoted when it could be misread. */
const bodyLine = (path: string) =>
	path.includes('\n') || path.startsWith('"') || path === CHANGED
		? JSON.stringify(path)
		: path;

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
			// Another process may have committed these paths meanwhile: look again, once.
			if (tries === 2) throw error;
		}
	}
}

/**
 * Stage and commit everything pending, as `<app>: <message>` with each path
 * beneath `Changed:`; `null` when nothing was.
 */
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
		const paths = staged.split('\0').filter(Boolean);
		if (paths.length === 0) return null;
		const subject = `${app}: ${message}`;
		try {
			await gitWaitingForIndex(folder, [
				'commit',
				'-q',
				'-m',
				`${subject}\n\n${CHANGED}\n${paths.map(bodyLine).join('\n')}`,
				'--',
				...TAKEN,
			]);
			return { subject, files: paths.length };
		} catch (error) {
			// Another process's snapshot may have committed what this one staged: look again, once.
			if (tries === 2) throw error;
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
				failed:
					'the repository is in the middle of a merge, rebase, revert, or cherry-pick; finish or abort it first',
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
		return { failed: extractErrorMessage(error) };
	}
}

/** The commit running or waiting for each folder, so this process makes one at a time per app. */
const queued = new Map<string, Promise<Snapshot>>();

/**
 * Commit in the app's folder (ADR-0850): with `{ wrote }`, exactly the
 * call's changed paths, named for the call (`<call> (threw)` when it threw),
 * with no body; otherwise everything pending that Git does not ignore, as
 * `<app>: changed outside epicenter` or `<app>: <message>`, its paths beneath
 * `Changed:`. Refused before staging when what it would take holds a
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
		.catch((error): Snapshot => ({ failed: extractErrorMessage(error) }));
	queued.set(folder, next);
	void next.then(() => {
		if (queued.get(folder) === next) queued.delete(folder);
	});
	return next;
}
