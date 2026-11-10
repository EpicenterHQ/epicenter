/**
 * An app's history is snapshots (ADR-0850). A run never commits; a snapshot
 * commits everything pending in the app's folder. A write run reports its
 * call and paths to the parent, which gives them to the snapshot.
 *
 * Who takes a snapshot: the command line after a write run it ran itself,
 * `serve` after each write call and for outside edits unchanged between two checks,
 * and `epicenter sync` before it pushes.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';
import { git, gitMessage } from './git.ts';

/** The write run that led to this snapshot. */
export type Wrote = { call: string; paths: string[] };

/** The body header for paths a call did not write. `epicenter history` parses it. */
export const ALSO_CHANGED = 'Also changed:';
/** The body header for paths taken without a call. `epicenter history` parses it. */
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

/** What a snapshot did: the commit it made, nothing (nothing was pending, or the folder is in no repository), or why it failed. */
export type Snapshot =
	| { committed: { subject: string; files: number } }
	| { committed: null }
	| { failed: string };

/**
 * What a snapshot takes: everything in the folder except `*.local` and
 * `*.local.*`, which never leave this computer whatever the app's
 * `.gitignore` says (a token, a device's settings).
 */
const TAKEN = ['.', ':(exclude)*.local', ':(exclude)*.local.*'];

/** Refused before staging when committing would store whole files that `.gitattributes` routes through LFS (ADR-0856). */
const LFS_MISSING =
	'.gitattributes routes files through Git LFS, and this computer has no LFS filter, so Git would store them whole; run: git lfs install';

/** How long a commit waits for someone else's hold on Git's index lock before giving up. */
const INDEX_LOCK_WAIT_MS = 2_000;

/**
 * Git with the snapshot's own `:(exclude)` pathspec, retried while another
 * Git process holds `index.lock`, so a commit that meets an editor's or
 * agent's `git add` waits its turn; after about 2 seconds it throws Git's
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

/**
 * `git status --porcelain` of what a snapshot of `folder` would take now,
 * one NUL-terminated entry per path; empty when nothing is pending, and
 * `undefined` when the folder is in no repository.
 */
export async function pendingStatus(folder: string) {
	const args = [
		'status',
		'--porcelain',
		'-z',
		'--untracked-files=all',
		'--no-renames',
		'--',
		...TAKEN,
	];
	const result = await git(folder, args, true);
	return result.code === 0 ? result.stdout : undefined;
}

/**
 * What Git says is pending and not yet backed up. A missing origin tracking
 * branch gives no unpushed count because its distance cannot be known.
 */
export async function statusOf(folder: string) {
	const status = await pendingStatus(folder);
	if (status === undefined) return undefined;
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
		pending: status.split('\0').filter(Boolean).length,
		...(counted?.code === 0 ? { unpushed: Number(counted.stdout) } : {}),
	};
}

/** A call names its snapshot; other pending paths follow a body header. */
function messageOf(app: string, wrote: Wrote | undefined, paths: string[]) {
	const subject = wrote?.call ?? `${app}: changed outside epicenter`;
	const other = wrote
		? paths.filter((path) => !wrote.paths.includes(path))
		: paths;
	const body = other.length
		? `${wrote ? ALSO_CHANGED : CHANGED}\n${other
				.map((path) =>
					path.includes('\n') ||
					path.startsWith('"') ||
					path === ALSO_CHANGED ||
					path === CHANGED
						? JSON.stringify(path)
						: path,
				)
				.join('\n')}`
		: '';
	return body ? `${subject}\n\n${body}` : subject;
}

/** Stage and commit everything pending; `null` when nothing was. */
async function commitPending(app: string, folder: string, wrote?: Wrote) {
	const attributes = await readFile(
		join(folder, '.gitattributes'),
		'utf8',
	).catch(() => '');
	if (
		attributes.includes('filter=lfs') &&
		(await git(folder, ['config', '--get', 'filter.lfs.process'])).stdout === ''
	)
		throw new Error(LFS_MISSING);
	for (let tries = 1; ; tries++) {
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
		const message = messageOf(app, wrote, paths);
		try {
			await gitWaitingForIndex(folder, [
				'commit',
				'-q',
				'-m',
				message,
				'--',
				...TAKEN,
			]);
			return { subject: message.split('\n')[0] as string, files: paths.length };
		} catch (error) {
			// Another process's snapshot may have committed what this one staged: look again, once.
			if (tries === 2) throw error;
		}
	}
}

async function take(
	app: string,
	folder: string,
	wrote?: Wrote,
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
		return { committed: await commitPending(app, folder, wrote) };
	} catch (error) {
		return { failed: extractErrorMessage(error) };
	}
}

/** The snapshot running or waiting for each folder, so this process takes one at a time per app. */
const queued = new Map<string, Promise<Snapshot>>();

/**
 * Commit everything pending in the app's folder as one snapshot (ADR-0850):
 * `git add -A` and `git commit`, never `*.local` or `*.local.*`, refused
 * before staging when `.gitattributes` routes files through LFS and this
 * computer has no filter, or when a Git operation is underway. The subject is
 * the reported call, or `<app>: changed outside epicenter`. The body names
 * other pending paths, or all pending paths when there is no call. A failure
 * is returned to the caller.
 */
export function snapshot(
	app: string,
	folder: string,
	wrote?: Wrote,
): Promise<Snapshot> {
	const next = (queued.get(folder) ?? Promise.resolve())
		.then(() => take(app, folder, wrote))
		.catch((error): Snapshot => ({ failed: extractErrorMessage(error) }));
	queued.set(folder, next);
	void next.then(() => {
		if (queued.get(folder) === next) queued.delete(folder);
	});
	return next;
}
