/**
 * An app's history is snapshots (ADR-0850). A run never commits; a snapshot
 * commits everything pending in the app's folder, named by what is known:
 * the calls that wrote since the last snapshot, from the app's call log, and
 * the paths no logged call wrote, as changed outside epicenter.
 *
 * Both files live in the repository's Git directory, never in the folder:
 *
 * - `epicenter-calls`: one JSON line per write run, `{ call, paths }`,
 *   appended when the run ends. A snapshot renames it aside before reading
 *   it, so a run that ends meanwhile starts a new log for the next snapshot.
 * - `epicenter-snapshot-error`: why the last snapshot failed; removed by the
 *   next one that succeeds.
 *
 * Who takes a snapshot: the command line after a write run it ran itself,
 * `serve` after each write call and for outside edits that have gone quiet,
 * and `epicenter sync` before it pulls.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';
import { git, gitMessage } from './git.ts';

/** One line of the call log: a write run's name and the paths it wrote. */
type Call = { call: string; paths: string[] };

/** What a snapshot did: the commit it made, nothing (nothing was pending, or the folder is in no repository), or why it failed. */
export type Snapshot =
	| { committed: { subject: string; files: number } }
	| { committed: null }
	| { failed: string };

const CALLS = 'epicenter-calls';
const FAILED = 'epicenter-snapshot-error';

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

/** Where the call log and the last failure are, in the Git directory of the repository `folder` is in; `undefined` when it is in none. */
async function filesOf(folder: string) {
	const found = await git(folder, [
		'rev-parse',
		'--is-inside-work-tree',
		'--git-path',
		CALLS,
		'--git-path',
		FAILED,
	]);
	const [inside, calls, failed] = found.stdout.split('\n');
	if (found.code !== 0 || inside !== 'true' || !calls || !failed)
		return undefined;
	return { calls: resolve(folder, calls), failed: resolve(folder, failed) };
}

/** Note in the app's call log that `call` wrote `paths`. A folder in no repository keeps no log. */
export async function logCall(folder: string, call: string, paths: string[]) {
	const files = await filesOf(folder);
	if (files)
		await appendFile(files.calls, `${JSON.stringify({ call, paths })}\n`);
}

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
 * What is in `folder` and not yet in its history: how many paths are pending,
 * and why the last snapshot failed, when it did. `undefined` when the folder
 * is in no repository.
 */
export async function historyOf(folder: string) {
	const status = await pendingStatus(folder);
	if (status === undefined) return undefined;
	const files = await filesOf(folder);
	const failed = files
		? (await readFile(files.failed, 'utf8').catch(() => '')).trim()
		: '';
	return {
		pending: status.split('\0').filter(Boolean).length,
		...(failed ? { failed } : {}),
	};
}

/** The commit message for `paths` and the `calls` logged since the last snapshot. */
function messageOf(app: string, calls: Call[], paths: string[]) {
	const pending = new Set(paths);
	// A call whose changes are already in history, or were undone, names nothing here.
	const named = calls.filter((call) => call.paths.some((p) => pending.has(p)));
	const logged = new Set(named.flatMap((call) => call.paths));
	const outside = paths.filter((path) => !logged.has(path));
	const [only] = named;
	const subject =
		named.length === 1 && only
			? only.call
			: `${app}: ${paths.length} ${paths.length === 1 ? 'change' : 'changes'}`;
	const body = [
		...(named.length > 1 ? named.map((call) => call.call) : []),
		...(outside.length
			? [`Changed outside epicenter: ${outside.join(', ')}`]
			: []),
	];
	return body.length ? `${subject}\n\n${body.join('\n')}` : subject;
}

/** Stage and commit everything pending, named for `calls`; `null` when nothing was. */
async function commitPending(app: string, folder: string, calls: Call[]) {
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
		const message = messageOf(app, calls, paths);
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

async function take(app: string, folder: string): Promise<Snapshot> {
	const files = await filesOf(folder);
	if (!files) return { committed: null };
	const { calls: log, failed: failure } = files;
	const aside = `${log}.${randomUUID()}`;
	let logged = '';
	try {
		try {
			await rename(log, aside);
			logged = await readFile(aside, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		const calls = logged
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Call);
		const committed = await commitPending(app, folder, calls);
		await rm(aside, { force: true });
		await rm(failure, { force: true });
		return { committed };
	} catch (error) {
		const reason = extractErrorMessage(error);
		try {
			// The calls stay logged for the snapshot that takes their changes.
			if (logged) await appendFile(log, logged);
			await rm(aside, { force: true });
			await writeFile(failure, `${reason}\n`);
		} catch {}
		return { failed: reason };
	}
}

/** The snapshot running or waiting for each folder, so this process takes one at a time per app. */
const queued = new Map<string, Promise<Snapshot>>();

/**
 * Commit everything pending in the app's folder as one snapshot (ADR-0850):
 * `git add -A` and `git commit`, never `*.local` or `*.local.*`, refused
 * before staging when `.gitattributes` routes files through LFS and this
 * computer has no filter. The subject is the one call logged since the last
 * snapshot, else `<app>: <n> changes`; the body lists the calls when there
 * are several, then the paths no logged call wrote. Nothing pending makes no
 * commit. A failure is never thrown: it leaves everything pending, keeps the
 * calls logged, and is kept for the app's status until a snapshot succeeds.
 */
export function snapshot(app: string, folder: string): Promise<Snapshot> {
	const next = (queued.get(folder) ?? Promise.resolve())
		.then(() => take(app, folder))
		.catch((error): Snapshot => ({ failed: extractErrorMessage(error) }));
	queued.set(folder, next);
	void next.then(() => {
		if (queued.get(folder) === next) queued.delete(folder);
	});
	return next;
}
