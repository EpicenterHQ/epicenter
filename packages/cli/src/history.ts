/**
 * `epicenter history <app>` reads an app's snapshots, and `epicenter undo
 * <app> [<commit>]` reverts one (ADR-0850). Both read only the app's own
 * repository: the app's folder must be its root, so an undo can never touch
 * a file outside the app.
 *
 * A commit's subject names it (`snapshot.ts`): a call's subject is the call,
 * and a snapshot with no call reads `<app>: changed outside epicenter` or
 * `<app>: <message>`. Its paths come from Git. An undo is a commit whose
 * subject is `<app>: undid <subject>` and whose body keeps Git's own `This
 * reverts commit <sha>.` line, so undoing an undo redoes it.
 *
 * Undo never loses anything. It snapshots what is pending first, refuses
 * rather than guesses (a commit not in the app's history, nothing to undo, a
 * revert Git refuses, that conflicts, or that changes nothing), and on any
 * refusal leaves the folder's files as they were.
 */
import { realpath } from 'node:fs/promises';
import { extractErrorMessage } from 'wellcrafted/error';
import { misuse, parseWords } from './commands.ts';
import { CliError } from './errors.ts';
import { checkedGit, git, gitMessage } from './git.ts';
import { chooseApps, type Entry } from './home.ts';
import { fail, writeJson, writeOut } from './output.ts';
import { snapshot, underway } from './snapshot.ts';

/** Git's own line in a revert's body, naming the commit it reverts. */
const REVERTS = /^This reverts commit ([0-9a-f]{40}|[0-9a-f]{64})\.$/m;

/** How many snapshots `history` shows without `--limit`. */
const DEFAULT_LIMIT = 20;

/** One commit as `git log` gives it. */
type Commit = {
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
function commitsIn(logged: string): Commit[] {
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
			return {
				commit,
				short,
				parents: parents.split(' ').filter(Boolean),
				date,
				time: Number(time),
				subject,
				body: body.replace(/\n+$/, ''),
				paths: [first.replace(/^\n/, ''), ...rest].filter(Boolean),
			};
		});
}

const refuse = (message: string, next?: string) =>
	CliError.Refused({ message, ...(next ? { next } : {}) }).error;

/**
 * The app named `name` and its folder, when the folder is the root of its own
 * repository; otherwise why not.
 */
async function appRepository(
	name: string,
): Promise<{ folder: string } | { error: CliError }> {
	const { data: chosen, error } = await chooseApps(name);
	if (error) return { error };
	const [{ realPath: folder }] = chosen as [Entry];
	const top = await git(folder, ['rev-parse', '--show-toplevel']);
	const root = top.code === 0 ? await realpath(top.stdout).catch(() => '') : '';
	if (root !== folder)
		return {
			error: refuse(
				`${name}'s folder is not the root of a Git repository of its own, so it has no history to read or undo`,
			),
		};
	return { folder };
}

/**
 * The commits on the app's line of history, newest first, following each
 * merge's first parent, each with the paths it changed from that parent; at
 * most `limit` of them. Empty in a repository with no commits yet.
 */
async function commitsOf(folder: string, limit?: number): Promise<Commit[]> {
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
	);
}

/** The commit `commit` reverts, when its body has Git's revert line. */
function revertedBy(commit: Commit) {
	return REVERTS.exec(commit.body)?.[1];
}

/** A commit as `history --json` gives it: `changed` is every path it changed, and `undid` the commit an undo reverts. */
function snapshotOf(commit: Commit) {
	const undid = revertedBy(commit);
	return {
		commit: commit.commit,
		date: commit.date,
		subject: commit.subject,
		changed: commit.paths,
		...(undid ? { undid } : {}),
	};
}

/** `seconds` as local time, plainly: `2026-11-11 09:30`. */
function localTime(seconds: number) {
	const at = new Date(seconds * 1000);
	const two = (n: number) => String(n).padStart(2, '0');
	return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/**
 * History as a person reads it: one line per commit, its short hash, its
 * local time, and its subject (an undo reads `undid <subject>`), then each
 * path it changed beneath.
 */
function renderHistory(app: string, commits: Commit[]) {
	const undoPrefix = `${app}: undid `;
	return commits
		.map((commit) => {
			const head = `${commit.short}  ${localTime(commit.time)}  `;
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
	const found = await appRepository(name);
	if ('error' in found) return fail(found.error, json);
	const commits = await commitsOf(found.folder, Number(limit));
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

/** The commit `given` names, when it is a commit on `app`'s history. */
async function namedUndoable(app: string, folder: string, given: string) {
	const notOurs = () => ({
		error: refuse(
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

/** What `undo` did: the commit it reverted and the undo commit it made. */
type Undone = { undid: string; commit: string; subject: string };

async function undo(
	app: string,
	folder: string,
	given: string | undefined,
): Promise<Undone | { error: CliError }> {
	// A named commit is checked before the snapshot, so a refusal adds nothing to history.
	const named =
		given === undefined ? undefined : await namedUndoable(app, folder, given);
	if (named && 'error' in named) return named;
	const taken = await snapshot(app, folder);
	if ('failed' in taken)
		return {
			error: refuse(
				`${app}: nothing was undone, since what is pending could not be snapshotted first: ${taken.failed.message}`,
				taken.failed.next ?? `epicenter sync ${app}`,
			),
		};
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
	const chosen = named ?? newestUndoable(app, await commitsOf(folder));
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
		return stopped(
			conflicted.length
				? `undoing ${short} ${target.subject} conflicts with later changes to ${conflicted.join(', ')}`
				: `could not undo ${short} ${target.subject} (${gitMessage(revertArgs, reverted)})`,
			`epicenter history ${app}`,
		);
	}
	if ((await git(folder, ['diff', '--cached', '--quiet'])).code === 0)
		return stopped(
			`undoing ${short} ${target.subject} changes nothing now, since later changes already undid it`,
			`epicenter history ${app}`,
		);
	const message = `${app}: undid ${target.subject}\n\nThis reverts commit ${target.commit}.`;
	const commitArgs = ['commit', '-q', '-m', message];
	const committed = await git(folder, commitArgs);
	if (committed.code !== 0)
		return stopped(
			`could not commit the undo of ${short} ${target.subject} (${gitMessage(commitArgs, committed)})`,
		);
	return {
		undid: target.commit,
		commit: (await git(folder, ['rev-parse', 'HEAD'])).stdout,
		subject: target.subject,
	};
}

/** `epicenter undo <app> [<commit>]`. */
export async function undoCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const parsed = parseWords(words, {}, [1, 2]);
	if (!parsed) return fail(misuse('undo'), json);
	const [name = '', given] = parsed.positionals;
	const found = await appRepository(name);
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
	if (json) writeJson({ undid: done.undid, commit: done.commit });
	else writeOut(`undid ${done.subject}`);
	return 0;
}
