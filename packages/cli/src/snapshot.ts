/**
 * An app's history is commits, each with a boundary its writer knew
 * (ADR-0850), in two repositories (ADR-0877): the app's folder holds its
 * code, and `data/` its data (`data.ts`).
 *
 * A call's commit goes to the data repository and holds exactly the paths
 * its run wrote, among those that changed, and nothing else pending
 * (`run.ts`); a run writes only under `data/` (ADR-0876). A snapshot with no
 * call commits everything pending in both repositories: `epicenter sync`
 * before it pushes (with `--message`, for an agent naming its own edits),
 * `epicenter undo` before it reverts, `epicenter update` before it merges,
 * and `serve`'s backup clock. Every data commit carries `Code-Commit: <sha>`,
 * the code's `HEAD` when it was made. Whoever commits holds the app's lock
 * (`lock.ts`), so a snapshot never takes part of what a running call has
 * written, from any process.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isLocalPath } from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import {
	codeCommitOf,
	codeTrailer,
	DATA,
	dataFolder,
	dataRepository,
	inData,
	isRepositoryTop,
} from './data.ts';
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

/**
 * What a commit in one repository did: the commit it made, nothing (nothing
 * it would take had changed, or there is no repository), or why it failed
 * and, when one is known, the command that resolves it.
 */
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
async function refuseLocal(label: string, folder: string, status: string) {
	const local = statusEntries(status).find((entry) => isLocalPath(entry.path));
	if (local === undefined) return;
	const prefix = (await git(folder, ['rev-parse', '--show-prefix'])).stdout;
	const inFolder = local.path.startsWith(prefix)
		? local.path.slice(prefix.length)
		: local.path;
	if (local.code === '??')
		throw new Refused(
			`${inFolder} would be committed; add *.local and *.local.* to ${label}/.gitignore`,
		);
	// A commit of named paths takes a file's bytes from the folder even once
	// it is out of the index, so its removal is committed by Git alone.
	const commit = `git -C ${folder} commit -m "${label.split('/')[0]}: stop tracking ${inFolder}"`;
	throw new Refused(
		`${inFolder} would be committed: Git already tracks it, so ${label}/.gitignore cannot keep it out`,
		local.code.startsWith('D')
			? commit
			: `git -C ${folder} rm --cached -- ${inFolder} && ${commit}`,
	);
}

/**
 * What Git says is pending and how the app is backed up; `undefined` for a
 * folder in no repository. `backup` is `'none'` with no `origin` remote and
 * `'never'` when `origin` has no tracking ref for the branch, so it has never
 * received it; otherwise `unpushed` counts the commits not yet backed up.
 */
export async function statusOf(
	folder: string,
): Promise<
	{ pending: number; backup?: 'none' | 'never'; unpushed?: number } | undefined
> {
	const status = await git(folder, statusArgs(TAKEN), true);
	if (status.code !== 0) return undefined;
	const pending = statusPaths(status.stdout).length;
	const origin = await originOf(folder);
	if (origin === null) return { pending, backup: 'none' };
	if (origin.ahead === undefined) return { pending, backup: 'never' };
	return { pending, unpushed: origin.ahead };
}

/** One repository to commit in: its folder, how messages name it (`vocab`, `vocab/data`), and the trailer its commits carry. */
type Repository = { folder: string; label: string; trailer?: string };

/** `git commit`'s arguments for `subject`, with the repository's trailer, of `pathspec`. */
const commitArgs = (
	repository: Repository,
	subject: string,
	pathspec: string[],
) => [
	'commit',
	'-q',
	'-m',
	subject,
	...(repository.trailer ? ['--trailer', repository.trailer] : []),
	'--',
	...pathspec,
];

/** What Git says of one repository, as `statusOf` reads it. */
export type RepositoryStatus = NonNullable<
	Awaited<ReturnType<typeof statusOf>>
>;

/**
 * What Git says of each of the app's repositories, as the listing shows it:
 * `code` when the app's folder is the top of its own repository, and `data`
 * when `data/` is. `data.otherCode` names the code commit the data's newest
 * commit was written under when this code's history does not hold it, as
 * after restoring the two from backups that do not match.
 */
export async function appStatusOf(folder: string): Promise<{
	code?: RepositoryStatus;
	data?: RepositoryStatus & { otherCode?: string };
}> {
	const code = (await isCodeRepository(folder))
		? await statusOf(folder)
		: undefined;
	const dataPath = dataFolder(folder);
	if (!(await isRepositoryTop(dataPath))) return code ? { code } : {};
	const data = await statusOf(dataPath);
	if (!data) return code ? { code } : {};
	const body = await git(dataPath, ['log', '-1', '--format=%b']);
	const written = body.code === 0 ? codeCommitOf(body.stdout) : undefined;
	const held =
		written === undefined ||
		!code ||
		(await git(folder, ['merge-base', '--is-ancestor', written, 'HEAD']))
			.code === 0;
	return {
		...(code ? { code } : {}),
		data: held ? data : { ...data, otherCode: written.slice(0, 12) },
	};
}

/**
 * Commit exactly the paths `wrote` reports that have changed, named for its
 * call: one `git status` of those paths drops what is unchanged, ignored, or
 * created and then deleted; `git add -A` and `git commit` of what is left
 * leave every other pending or staged change as it was. `null` when none
 * changed. The paths are inside `repository`.
 */
async function commitCall(repository: Repository, wrote: Wrote) {
	const { folder } = repository;
	if (wrote.paths.length === 0) return null;
	const subject = wrote.threw ? `${wrote.call} (threw)` : wrote.call;
	const written = wrote.paths.map((path) => `:(literal)${path}`);
	const status = await gitWaitingForIndex(folder, statusArgs(written));
	const paths = statusPaths(status);
	if (paths.length === 0) return null;
	await refuseLocal(repository.label, folder, status);
	const changed = paths.map((path) => `:(top,literal)${path}`);
	await gitWaitingForIndex(folder, ['add', '-A', '--', ...changed]);
	await gitWaitingForIndex(folder, commitArgs(repository, subject, changed));
	return { subject, files: changed.length };
}

/** Stage and commit everything pending, as `<app>: <message>`; `null` when nothing was. */
async function commitPending(
	app: string,
	repository: Repository,
	message: string,
) {
	const { folder } = repository;
	await refuseLocal(
		repository.label,
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
	await gitWaitingForIndex(folder, commitArgs(repository, subject, TAKEN));
	return { subject, files };
}

/**
 * Whose boundary a commit has: a call's, which takes only the paths it
 * wrote, or none, which takes everything pending under `message` (default
 * `changed outside epicenter`).
 */
type Boundary = { wrote: Wrote } | { message?: string };

/**
 * Commit in one repository: with `{ wrote }`, exactly the call's changed
 * paths, named for the call (`<call> (threw)` when it threw), with no body;
 * otherwise everything pending that Git does not ignore, as
 * `<app>: changed outside epicenter` or `<app>: <message>`. Refused before
 * staging when what it would take holds a `*.local` or `*.local.*` file, when
 * `.gitattributes` routes files through LFS and this computer has no filter,
 * or when a Git operation is underway. Never throws: a failure is returned.
 */
async function commitIn(
	app: string,
	repository: Repository,
	boundary: Boundary,
): Promise<Snapshot> {
	const { folder } = repository;
	try {
		if (await underway(folder))
			return {
				failed: {
					message: `${repository.label} is in the middle of a merge, rebase, revert, or cherry-pick; finish or abort it first`,
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
					? await commitCall(repository, boundary.wrote)
					: await commitPending(
							app,
							repository,
							boundary.message ?? 'changed outside epicenter',
						),
		};
	} catch (error) {
		return failedWith(error);
	}
}

/** A thrown failure as a `Snapshot`, keeping a refusal's next step. */
function failedWith(error: unknown): Snapshot {
	return {
		failed: {
			message: extractErrorMessage(error),
			...(error instanceof Refused && error.next ? { next: error.next } : {}),
		},
	};
}

/**
 * The data repository of the app `app` at `folder`, as a commit takes it,
 * made when `make` and missing; `undefined` when there is none.
 */
async function dataOf(app: string, folder: string, make: boolean) {
	const data = await dataRepository(app, folder, { make });
	if (data === undefined) return undefined;
	return {
		folder: data,
		label: `${app}/${DATA}`,
		trailer: await codeTrailer(folder),
	} satisfies Repository;
}

/**
 * Commit a call's writes, `wrote.paths` from the app's folder, all under
 * `data/` (ADR-0876), to the app's data repository, making it first when it
 * has none (`data.ts`). Its caller holds the app's lock.
 */
export async function commitWrites(
	app: string,
	folder: string,
	wrote: Wrote,
): Promise<Snapshot> {
	try {
		const data = await dataOf(app, folder, true);
		if (data === undefined) return { committed: null };
		const paths = wrote.paths
			.filter((path) => path.startsWith(`${DATA}/`))
			.map(inData);
		return commitIn(app, data, { wrote: { ...wrote, paths } });
	} catch (error) {
		return failedWith(error);
	}
}

/** What a snapshot of an app did in each repository; `null` for one the app does not have. */
export type AppSnapshot = { code: Snapshot | null; data: Snapshot | null };

/**
 * Snapshot everything pending in the app at `folder`: its code first, as
 * `<app>: <message>` (default `changed outside epicenter`), then its data,
 * whose commit names the code commit just made. The code repository is the
 * app's folder when that is the top of a repository; it refuses to commit
 * while its `.gitignore` does not keep `data/` out. The data repository is
 * made when `data/` holds files but no repository yet. Its caller holds the
 * app's lock. Never throws.
 */
export async function snapshotApp(
	app: string,
	folder: string,
	message?: string,
): Promise<AppSnapshot> {
	const code = (await isCodeRepository(folder))
		? await snapshotCode(app, folder, message)
		: null;
	let data: Snapshot | null;
	try {
		const repository = await dataOf(
			app,
			folder,
			existsSync(dataFolder(folder)),
		);
		data = repository ? await commitIn(app, repository, { message }) : null;
	} catch (error) {
		data = failedWith(error);
	}
	return { code, data };
}

/** Whether the app's folder is the top of its own repository, its code's. */
async function isCodeRepository(folder: string) {
	const top = await git(folder, ['rev-parse', '--show-prefix']);
	return top.code === 0 && top.stdout === '';
}

/** Commit what is pending in the code, refusing while `data/` is not ignored. */
async function snapshotCode(
	app: string,
	folder: string,
	message: string | undefined,
): Promise<Snapshot> {
	const ignored = await git(
		folder,
		['check-ignore', '--no-index', '-q', `${DATA}/`],
		true,
	);
	if (ignored.code !== 0)
		return {
			failed: {
				message: `${app}/.gitignore does not list ${DATA}/, so a commit of the code could take the data`,
				next: `printf '${DATA}/\n' >> ${join(folder, '.gitignore')}`,
			},
		};
	return commitIn(app, { folder, label: app }, { message });
}

/** The first failure in an app's snapshot, naming the repository it came from. */
export function failureOf(taken: AppSnapshot) {
	for (const which of ['code', 'data'] as const) {
		const outcome = taken[which];
		if (outcome && 'failed' in outcome) return outcome.failed;
	}
	return undefined;
}
