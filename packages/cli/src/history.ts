/**
 * `epicenter history <app>` reads an app's snapshots, and `epicenter undo
 * <app> [<commit>]` reverts one (ADR-0850). An app has two repositories
 * (ADR-0877): its folder holds its code and `data/` its data. History shows
 * both in time order, each commit marked with its repository; undo reverts
 * data commits only, since code is reverted with Git by whoever edits it.
 * Each reads only a repository whose top is its own folder, so an undo can
 * never touch a file outside the app.
 *
 * A commit's subject names it (`snapshot.ts`): a call's subject is the call,
 * and a snapshot with no call reads `<app>: changed outside epicenter` or
 * `<app>: <message>`. Its paths come from Git. An undo is a commit whose
 * subject is `<app>: undid <subject>` and whose body keeps Git's own `This
 * reverts commit <sha>.` line, so undoing an undo redoes it.
 *
 * Every data commit names the code it was written under (`Code-Commit:`).
 * When the commit an undo reverts names code other than the code's `HEAD`,
 * the undo lists the code commits made since, so whoever undid a record
 * rewrite sees the field change it went with.
 *
 * Undo never loses anything. It holds the app's lock (`lock.ts`) from its
 * snapshot of what is pending until its revert is committed, so no call
 * writes in between, and it refuses
 * rather than guesses (a commit not in the app's history, nothing to undo, a
 * revert Git refuses, that conflicts, or that changes nothing), and on any
 * refusal leaves the folder's files as they were.
 */
import { extractErrorMessage } from 'wellcrafted/error';
import { misuse, parseWords } from './commands.ts';
import {
	codeCommitOf,
	codeHead,
	codeTrailer,
	dataFolder,
	fromData,
	isRepositoryTop,
} from './data.ts';
import { CliError } from './errors.ts';
import { checkedGit, git, gitMessage } from './git.ts';
import { chooseApps, type Entry } from './home.ts';
import { LOCK_WAIT_MS, locked } from './lock.ts';
import { fail, writeJson, writeOut } from './output.ts';
import { failureOf, snapshotApp, underway } from './snapshot.ts';

/** Git's own line in a revert's body, naming the commit it reverts. */
const REVERTS = /^This reverts commit ([0-9a-f]{40}|[0-9a-f]{64})\.$/m;

/** How many snapshots `history` shows without `--limit`. */
const DEFAULT_LIMIT = 20;

/** Which of an app's repositories a commit is in. */
type Repository = 'code' | 'data';

/** One commit as `git log` gives it. */
type Commit = {
	repository: Repository;
	commit: string;
	/** Its abbreviated hash, as long as the repository needs it to be unique. */
	short: string;
	parents: string[];
	/** The author date, ISO 8601 with its offset. */
	date: string;
	/** The author date, in seconds since the epoch. */
	time: number;
	subject: string;
	body: string;
	/** The paths it changed from its first parent, as `--name-only` lists them; none when the log asked for none. */
	paths: string[];
};

/** The `git log -z` format `commitsIn` reads: RS before each commit, its fields apart by US. */
const FORMAT = '--format=%x1e%H%x1f%h%x1f%P%x1f%aI%x1f%at%x1f%s%x1f%b';

/**
 * The commits in `git log -z` output written in `FORMAT`. With
 * `--name-only`, Git follows each commit's fields with NUL, a newline, and
 * each path it changed, NUL after each.
 */
function commitsIn(logged: string, repository: Repository): Commit[] {
	return logged
		.split('\x1e')
		.filter(Boolean)
		.map((record) => {
			const [head = '', first = '', ...rest] = record.split('\0');
			const [
				commit = '',
				short = '',
				parents = '',
				date = '',
				time = '',
				subject = '',
				body = '',
			] = head.split('\x1f');
			const changed = [first.replace(/^\n/, ''), ...rest].filter(Boolean);
			return {
				repository,
				commit,
				short,
				parents: parents.split(' ').filter(Boolean),
				date,
				time: Number(time),
				subject,
				body: body.replace(/\n+$/, ''),
				paths: repository === 'data' ? changed.map(fromData) : changed,
			};
		});
}

const refuse = (message: string, next?: string) =>
	CliError.Refused({ message, ...(next ? { next } : {}) }).error;

/** The app named `name`: its folder, and which of its repositories it has. */
type AppRepositories = { folder: string; code: boolean; data: boolean };

/**
 * The app named `name`, its folder, and whether its code and its data are
 * each the top of a repository of their own; otherwise why not.
 */
async function appRepositories(
	name: string,
): Promise<AppRepositories | { error: CliError }> {
	const { data: chosen, error } = await chooseApps(name);
	if (error) return { error };
	const [{ realPath: folder }] = chosen as [Entry];
	const [code, data] = await Promise.all([
		isRepositoryTop(folder),
		isRepositoryTop(dataFolder(folder)),
	]);
	if (!code && !data)
		return {
			error: refuse(
				`${name} has no history: neither its folder nor its data/ is a Git repository of its own`,
			),
		};
	return { folder, code, data };
}

/**
 * The commits on the app's line of history, newest first, following each
 * merge's first parent, each with the paths it changed from that parent; at
 * most `limit` of them. Empty in a repository with no commits yet.
 */
async function commitsOf(
	folder: string,
	repository: Repository,
	limit?: number,
): Promise<Commit[]> {
	if ((await git(folder, ['rev-parse', '-q', '--verify', 'HEAD'])).code !== 0)
		return [];
	return commitsIn(
		await checkedGit(folder, [
			'log',
			'-z',
			'--first-parent',
			'--diff-merges=first-parent',
			'--name-only',
			'--no-renames',
			FORMAT,
			// Git reads -n as an int; a larger limit is every commit anyway.
			...(limit === undefined ? [] : [`-n${Math.min(limit, 2 ** 31 - 1)}`]),
			'HEAD',
		]),
		repository,
	);
}

/** Both repositories' commits, newest first, at most `limit` of them. */
async function appCommits(app: AppRepositories, limit: number) {
	const [code, data] = await Promise.all([
		app.code ? commitsOf(app.folder, 'code', limit) : [],
		app.data ? commitsOf(dataFolder(app.folder), 'data', limit) : [],
	]);
	return [...code, ...data].sort((a, b) => b.time - a.time).slice(0, limit);
}

/** The commit `commit` reverts, when its body has Git's revert line. */
function revertedBy(commit: Commit) {
	return REVERTS.exec(commit.body)?.[1];
}

/**
 * A commit as `history --json` gives it: its repository, `changed` (every
 * path it changed, from the app's folder), `code` (the code a data commit was
 * written under), and `undid` (the commit an undo reverts).
 */
function snapshotOf(commit: Commit) {
	const undid = revertedBy(commit);
	const code =
		commit.repository === 'data' ? codeCommitOf(commit.body) : undefined;
	return {
		repository: commit.repository,
		commit: commit.commit,
		date: commit.date,
		subject: commit.subject,
		changed: commit.paths,
		...(code ? { code } : {}),
		...(undid ? { undid } : {}),
	};
}

/** `seconds` as local time, plainly: `2026-11-11 09:30`; for a person reading, not a field (`localTime` in `@epicenter/app` is that). */
export function plainTime(seconds: number) {
	const at = new Date(seconds * 1000);
	const two = (n: number) => String(n).padStart(2, '0');
	return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/**
 * History as a person reads it: one line per commit, its short hash, its
 * local time, its repository, and its subject (an undo reads
 * `undid <subject>`), then each path it changed beneath.
 */
function renderHistory(app: string, commits: Commit[]) {
	const undoPrefix = `${app}: undid `;
	return commits
		.map((commit) => {
			const head = `${commit.short}  ${plainTime(commit.time)}  ${commit.repository}  `;
			const subject = commit.subject.startsWith(undoPrefix)
				? `undid ${commit.subject.slice(undoPrefix.length)}`
				: commit.subject;
			const paths = commit.paths.map(
				(path) => `${' '.repeat(head.length)}${path}\n`,
			);
			return `${head}${subject}\n${paths.join('')}`;
		})
		.join('');
}

/** `epicenter history <app> [--limit <n>]`. */
export async function historyCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const given = parseWords(words, { limit: { type: 'string' } }, [1, 1]);
	const { limit = `${DEFAULT_LIMIT}` } = given?.values ?? {};
	if (!given || !/^[1-9]\d*$/.test(limit)) return fail(misuse('history'), json);
	const [name = ''] = given.positionals;
	const found = await appRepositories(name);
	if ('error' in found) return fail(found.error, json);
	const commits = await appCommits(found, Number(limit));
	if (json) writeJson(commits.map(snapshotOf));
	else process.stdout.write(renderHistory(name, commits));
	return 0;
}

/** Tracked paths that differ from HEAD, NUL-separated; empty when the folder matches its last commit. */
function trackedChanges(folder: string) {
	return checkedGit(folder, [
		'status',
		'--porcelain',
		'-z',
		'--untracked-files=no',
		'--no-renames',
	]);
}

/**
 * Which commits on the app's line are undone: each undo that is not itself
 * undone undoes the commit its revert line names, so an undo of an undo
 * brings that commit back.
 */
function undoneIn(commits: Commit[]) {
	const undone = new Set<string>();
	// Newest first, so an undo is seen before the commit it reverts.
	for (const commit of commits) {
		if (undone.has(commit.commit)) continue;
		const target = revertedBy(commit);
		if (target) undone.add(target);
	}
	return undone;
}

/** The commit `undo` without a commit undoes: the newest that is neither an undo nor undone. */
function newestUndoable(app: string, commits: Commit[]) {
	const undone = undoneIn(commits);
	const candidate = commits.find(
		(commit) => !undone.has(commit.commit) && !revertedBy(commit),
	);
	if (!candidate)
		return {
			error: refuse(`${app} has nothing to undo`, `epicenter history ${app}`),
		};
	const { short } = candidate;
	if (
		candidate.parents.length === 0 ||
		!candidate.subject.startsWith(`${app}: `)
	)
		return {
			error: refuse(
				`${app} has no snapshot to undo: its most recent change, ${short} ${candidate.subject}, is not one`,
				...(candidate.parents.length === 0
					? [`epicenter history ${app}`]
					: [`epicenter undo ${app} ${short}`]),
			),
		};
	return { commit: candidate };
}

/**
 * The commit `given` names, when it is a commit in `app`'s data history. A
 * code commit is refused with the Git command that reverts it.
 */
async function namedUndoable(app: string, appFolder: string, given: string) {
	const folder = dataFolder(appFolder);
	const inCode = async () =>
		(await isRepositoryTop(appFolder)) &&
		(
			await git(appFolder, [
				'merge-base',
				'--is-ancestor',
				`${given}^{commit}`,
				'HEAD',
			])
		).code === 0;
	const notOurs = async () => ({
		error: (await inCode())
			? refuse(
					`${given} is a commit in ${app}'s code, and undo reverts data; code is reverted with Git`,
					`git -C ${appFolder} revert ${given}`,
				)
			: refuse(
					`${given} is not a commit in ${app}'s history`,
					`epicenter history ${app}`,
				),
	});
	const resolved = await git(folder, [
		'rev-parse',
		'-q',
		'--verify',
		'--end-of-options',
		`${given}^{commit}`,
	]);
	if (resolved.code !== 0) return notOurs();
	const sha = resolved.stdout;
	const ancestor = await git(folder, [
		'merge-base',
		'--is-ancestor',
		sha,
		'HEAD',
	]);
	if (ancestor.code !== 0) return notOurs();
	const [named] = commitsIn(
		await checkedGit(folder, ['log', '-1', '-z', FORMAT, sha]),
		'data',
	);
	return named ? { commit: named } : notOurs();
}

/**
 * Put the folder back after a revert that did not become a commit. Since the
 * folder matched its last commit before the revert, `git revert --abort`
 * returns every tracked file to it and leaves untracked files alone. Returns
 * what is known when the folder may not be as it was; never throws.
 */
async function putBack(folder: string, head: string) {
	await git(folder, ['revert', '--abort']);
	try {
		if (
			(await git(folder, ['rev-parse', 'HEAD'])).stdout === head &&
			(await trackedChanges(folder)) === '' &&
			!(await underway(folder))
		)
			return undefined;
	} catch {}
	return 'and the folder may not be as it was';
}

/**
 * What `undo` did: the commit it reverted, the undo commit it made, and the
 * code commits made since the reverted one was written, newest first, when
 * there are any.
 */
type Undone = {
	undid: string;
	commit: string;
	subject: string;
	codeSince?: { commit: string; subject: string }[];
};

async function undo(
	app: string,
	folder: string,
	given: string | undefined,
): Promise<Undone | { error: CliError }> {
	if (!(await isRepositoryTop(dataFolder(folder))))
		return {
			error: refuse(
				`${app} has no data history to undo: its data/ is not a Git repository of its own`,
			),
		};
	// A named commit is checked before the snapshot, so a refusal adds nothing to history.
	const named =
		given === undefined ? undefined : await namedUndoable(app, folder, given);
	if (named && 'error' in named) return named;
	const ran = await locked(folder, LOCK_WAIT_MS, () =>
		snapshotAndRevert(app, folder, named),
	);
	return 'busy' in ran
		? {
				error: refuse(
					`${app}: nothing was undone, since a call is still writing it`,
					`epicenter undo ${app}${given === undefined ? '' : ` ${given}`}`,
				),
			}
		: ran.done;
}

/**
 * Snapshot what is pending in both repositories, then revert `named`, or the
 * newest data commit undo may take, as one new data commit. Its caller holds
 * the app's lock throughout, so no call writes between the snapshot and the
 * revert.
 */
async function snapshotAndRevert(
	app: string,
	appFolder: string,
	named: { commit: Commit } | undefined,
): Promise<Undone | { error: CliError }> {
	const failed = failureOf(await snapshotApp(app, appFolder));
	if (failed)
		return {
			error: refuse(
				`${app}: nothing was undone, since what is pending could not be snapshotted first: ${failed.message}`,
				failed.next ?? `epicenter sync ${app}`,
			),
		};
	const folder = dataFolder(appFolder);
	const left = await trackedChanges(folder);
	if (left !== '')
		return {
			error: refuse(
				`${app} has changes a snapshot does not take (${left
					.split('\0')
					.filter(Boolean)
					.map((entry) => entry.slice(3))
					.join(', ')}), so nothing was undone`,
				`git -C ${folder} status`,
			),
		};
	const chosen = named ?? newestUndoable(app, await commitsOf(folder, 'data'));
	if ('error' in chosen) return chosen;
	const target = chosen.commit;
	const { short } = target;
	const head = (await git(folder, ['rev-parse', 'HEAD'])).stdout;
	const stopped = async (why: string, next?: string) => {
		const stuck = await putBack(folder, head);
		return {
			error: refuse(
				`${app}: ${why}, so nothing was undone${stuck ? `, ${stuck}` : '; the folder is as it was'}`,
				stuck ? `git -C ${folder} status` : next,
			),
		};
	};
	// rerere stays off, so no recorded resolution is applied or left behind.
	const revertArgs = [
		'-c',
		'rerere.enabled=false',
		'revert',
		'--no-commit',
		target.commit,
	];
	const reverted = await git(folder, revertArgs);
	if (reverted.code !== 0) {
		const conflicted = (
			await git(folder, ['diff', '--name-only', '-z', '--diff-filter=U'])
		).stdout
			.split('\0')
			.filter(Boolean);
		if (conflicted.length)
			return stopped(
				`undoing ${short} ${target.subject} conflicts with later changes to ${conflicted.join(', ')}`,
				`epicenter history ${app}`,
			);
		// Git reverts a merge only when told which parent's side to keep.
		const merge =
			(await git(folder, ['rev-parse', '-q', '--verify', `${target.commit}^2`]))
				.code === 0;
		return stopped(
			`could not undo ${short} ${target.subject} (${gitMessage(revertArgs, reverted)})`,
			merge
				? `git -C ${folder} revert -m 1 ${target.commit}`
				: `epicenter history ${app}`,
		);
	}
	if ((await git(folder, ['diff', '--cached', '--quiet'])).code === 0)
		return stopped(
			`undoing ${short} ${target.subject} changes nothing now, since later changes already undid it`,
			`epicenter history ${app}`,
		);
	const message = `${app}: undid ${target.subject}\n\nThis reverts commit ${target.commit}.`;
	const trailer = await codeTrailer(appFolder);
	const commitArgs = [
		'commit',
		'-q',
		'-m',
		message,
		...(trailer ? ['--trailer', trailer] : []),
	];
	const committed = await git(folder, commitArgs);
	if (committed.code !== 0)
		return stopped(
			`could not commit the undo of ${short} ${target.subject} (${gitMessage(commitArgs, committed)})`,
		);
	const codeSince = await codeCommitsSince(appFolder, target);
	return {
		undid: target.commit,
		commit: (await git(folder, ['rev-parse', 'HEAD'])).stdout,
		subject: target.subject,
		...(codeSince.length ? { codeSince } : {}),
	};
}

/**
 * The code commits made after the code `target` was written under, newest
 * first; none when it names no code, names the code's `HEAD`, or names a
 * commit this code's history does not have.
 */
async function codeCommitsSince(appFolder: string, target: Commit) {
	const written = codeCommitOf(target.body);
	const head = await codeHead(appFolder);
	if (written === undefined || head === undefined || written === head)
		return [];
	const logged = await git(appFolder, [
		'log',
		'--first-parent',
		'--format=%H%x1f%s',
		`${written}..HEAD`,
	]);
	if (logged.code !== 0) return [];
	return logged.stdout
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [commit = '', subject = ''] = line.split('\x1f');
			return { commit, subject };
		});
}

/** `epicenter undo <app> [<commit>]`. */
export async function undoCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const parsed = parseWords(words, {}, [1, 2]);
	if (!parsed) return fail(misuse('undo'), json);
	const [name = '', given] = parsed.positionals;
	const found = await appRepositories(name);
	if ('error' in found) return fail(found.error, json);
	let done: Undone | { error: CliError };
	try {
		done = await undo(name, found.folder, given);
	} catch (error) {
		// Only the steps before the revert can throw: from it on, every failure puts the folder back.
		return fail(
			refuse(`${name}: nothing was undone: ${extractErrorMessage(error)}`),
			json,
		);
	}
	if ('error' in done) return fail(done.error, json);
	if (json)
		writeJson({
			undid: done.undid,
			commit: done.commit,
			...(done.codeSince ? { codeSince: done.codeSince } : {}),
		});
	else
		writeOut(
			[
				`undid ${done.subject}`,
				...(done.codeSince
					? [
							`The code has changed since that was written; the data may not fit it:`,
							...done.codeSince.map(
								({ commit, subject }) => `  ${commit.slice(0, 7)}  ${subject}`,
							),
						]
					: []),
			].join('\n'),
		);
	return 0;
}
