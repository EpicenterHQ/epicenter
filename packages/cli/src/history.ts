/**
 * `epicenter history <app>` reads an app's snapshots, and `epicenter undo
 * <app> [<commit>]` reverts one (ADR-0850). Both read only the app's own
 * repository: the app's folder must be its root, so an undo can never touch
 * a file outside the app.
 *
 * A commit names what it took in its message (`snapshot.ts`): a call's
 * subject is the call, with no body; a snapshot with no call reads
 * `<app>: changed outside epicenter` or `<app>: <message>`, with `Changed:`
 * and one path per line beneath. An undo is a
 * commit whose subject is `<app>: undid <subject>` and whose body keeps Git's own
 * `This reverts commit <sha>.` line, so undoing an undo redoes it.
 *
 * Undo never loses anything. It snapshots what is pending first, refuses
 * rather than guesses (a merge, a commit not in the app's history, a commit
 * already undone, nothing to undo, a revert that conflicts or changes
 * nothing), and on any refusal leaves the folder's files as they were.
 */
import { realpath } from 'node:fs/promises';
import { extractErrorMessage } from 'wellcrafted/error';
import { COMMANDS } from './commands.ts';
import { CliError } from './errors.ts';
import { git, gitMessage } from './git.ts';
import { homeEntries } from './home.ts';
import { fail, writeJson, writeOut } from './output.ts';
import { CHANGED, snapshot, underway } from './snapshot.ts';

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
};

/** One snapshot as `epicenter history --json` gives it. */
export type Snapshot = {
	commit: string;
	date: string;
	subject: string;
	/** The paths its body names beneath `Changed:`: a snapshot with no call lists what it took; a call's commit, named for the call, lists none. */
	changed: string[];
	/** The commit this one reverts, when it is an undo. */
	undid?: string;
};

/** The `git log` format `commitOf` reads: fields apart by US. */
const FORMAT = '--format=%H%x1f%h%x1f%P%x1f%aI%x1f%at%x1f%s%x1f%b';

function commitOf(record: string): Commit {
	const [
		commit = '',
		short = '',
		parents = '',
		date = '',
		time = '',
		subject = '',
		body = '',
	] = record.split('\x1f');
	return {
		commit,
		short,
		parents: parents.split(' ').filter(Boolean),
		date,
		time: Number(time),
		subject,
		body: body.replace(/\n+$/, ''),
	};
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
	const found = (await homeEntries()).find((entry) => entry.entry === name);
	if (!found)
		return {
			error: CliError.Usage({
				message: `Unknown app "${name}"`,
				next: 'epicenter',
			}).error,
		};
	const folder = found.realPath;
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
 * merge's first parent; at most `limit` of them. Empty in a repository with
 * no commits yet.
 */
async function commitsOf(folder: string, limit?: number): Promise<Commit[]> {
	if ((await git(folder, ['rev-parse', '-q', '--verify', 'HEAD'])).code !== 0)
		return [];
	const args = [
		'log',
		'-z',
		'--first-parent',
		FORMAT,
		...(limit === undefined ? [] : [`-n${limit}`]),
		'HEAD',
	];
	const logged = await git(folder, args);
	if (logged.code !== 0) throw new Error(gitMessage(args, logged));
	return logged.stdout.split('\0').filter(Boolean).map(commitOf);
}

/** The commit `commit` reverts, when its body has Git's revert line. */
function revertedBy(commit: Commit) {
	return REVERTS.exec(commit.body)?.[1];
}

/** A commit as `history --json` gives it. */
function snapshotOf(commit: Commit): Snapshot {
	const lines = commit.body.split('\n');
	const header = lines.indexOf(CHANGED);
	const end = lines.findIndex((line, index) => index > header && line === '');
	const changed =
		header < 0
			? []
			: lines.slice(header + 1, end < 0 ? undefined : end).map((line) => {
					if (!line.startsWith('"')) return line;
					try {
						const decoded: unknown = JSON.parse(line);
						return typeof decoded === 'string' ? decoded : line;
					} catch {
						return line;
					}
				});
	const undid = revertedBy(commit);
	return {
		commit: commit.commit,
		date: commit.date,
		subject: commit.subject,
		changed,
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
 * local time, and its subject (an undo reads `undid <subject>`), then its
 * body's lines beneath, without Git's revert line.
 */
function renderHistory(app: string, commits: Commit[]) {
	const undoPrefix = `${app}: undid `;
	return commits
		.map((commit) => {
			const head = `${commit.short}  ${localTime(commit.time)}  `;
			const subject = commit.subject.startsWith(undoPrefix)
				? `undid ${commit.subject.slice(undoPrefix.length)}`
				: commit.subject;
			const body = commit.body
				.split('\n')
				.filter((line) => line.trim() !== '' && !REVERTS.test(line))
				.map((line) => `${' '.repeat(head.length)}${line}\n`);
			return `${head}${subject}\n${body.join('')}`;
		})
		.join('');
}

/** `epicenter history <app> [--limit <n>]`. */
export async function historyCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const bad = () =>
		fail(
			CliError.Usage({
				message:
					'epicenter history takes one app, and maybe --limit <n> (a whole number from 1 to 1000)',
				next: COMMANDS.history,
			}).error,
			json,
		);
	const [name, ...rest] = words;
	if (name === undefined || name.startsWith('-')) return bad();
	let limit = DEFAULT_LIMIT;
	if (rest.length > 0) {
		const [flag = '', value] = rest;
		const given = flag.startsWith('--limit=')
			? rest.length === 1 && flag.slice('--limit='.length)
			: flag === '--limit' && rest.length === 2 && value;
		if (!given || !/^[1-9]\d*$/.test(given)) return bad();
		limit = Number(given);
		if (!Number.isSafeInteger(limit) || limit > 1000) return bad();
	}
	const found = await appRepository(name);
	if ('error' in found) return fail(found.error, json);
	const commits = await commitsOf(found.folder, limit);
	if (json) writeJson(commits.map(snapshotOf));
	else process.stdout.write(renderHistory(name, commits));
	return 0;
}

/** Tracked paths that differ from HEAD, NUL-separated; empty when the folder matches its last commit. */
async function trackedChanges(folder: string) {
	const args = [
		'status',
		'--porcelain',
		'-z',
		'--untracked-files=no',
		'--no-renames',
	];
	const status = await git(folder, args);
	if (status.code !== 0) throw new Error(gitMessage(args, status));
	return status.stdout;
}

/**
 * Which commits on the app's line are undone: each undo that is not itself
 * undone undoes the commit its revert line names, so an undo of an undo
 * brings that commit back. Maps each undone commit to the undo that undid it.
 */
function undoneIn(commits: Commit[]) {
	const undone = new Map<string, Commit>();
	// Newest first, so an undo is seen before the commit it reverts.
	for (const commit of commits) {
		if (undone.has(commit.commit)) continue;
		const target = revertedBy(commit);
		if (target) undone.set(target, commit);
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
	if (candidate.parents.length > 1)
		return {
			error: refuse(
				`${app}'s most recent change is a merge, ${short} ${candidate.subject}, and undo does not undo a merge; name an older commit to undo`,
				`epicenter history ${app}`,
			),
		};
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

/** The commit `given` names, when it is a commit on `app`'s history that undo can revert. */
async function namedUndoable(
	app: string,
	folder: string,
	given: string,
	commits: Commit[],
) {
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
	const named = commitOf(
		(await git(folder, ['log', '-1', FORMAT, sha])).stdout,
	);
	const { short } = named;
	if (named.parents.length > 1)
		return {
			error: refuse(
				`${short} ${named.subject} is a merge, and undo does not undo a merge`,
				`epicenter history ${app}`,
			),
		};
	const undoneBy = undoneIn(commits).get(sha);
	if (undoneBy)
		return {
			error: refuse(
				`${short} ${named.subject} is already undone by ${undoneBy.short}; undo that to bring it back`,
				`epicenter undo ${app} ${undoneBy.short}`,
			),
		};
	return { commit: named };
}

/**
 * Put the folder back after a revert that did not become a commit. Since the
 * folder matched its last commit before the revert, `git revert --abort`
 * returns every tracked file to it and leaves untracked files alone. Returns
 * why the folder could not be put back, when it could not.
 */
async function putBack(folder: string, head: string) {
	await git(folder, ['revert', '--abort']);
	const now = await git(folder, ['rev-parse', 'HEAD']);
	if (
		now.stdout !== head ||
		(await trackedChanges(folder)) !== '' ||
		(await underway(folder))
	)
		return 'and the folder could not be put back as it was';
	return undefined;
}

/** What `undo` did: the commit it reverted and the undo commit it made. */
type Undone = { undid: string; commit: string; subject: string };

async function undo(
	app: string,
	folder: string,
	given: string | undefined,
): Promise<Undone | { error: CliError }> {
	if (await underway(folder))
		return {
			error: refuse(
				`${app} is in the middle of a merge, rebase, revert, or cherry-pick, so nothing was undone; finish or abort it first`,
				`git -C ${folder} status`,
			),
		};
	// A named commit is checked before the snapshot, so a refusal adds nothing to history.
	const named =
		given === undefined
			? undefined
			: await namedUndoable(app, folder, given, await commitsOf(folder));
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
	const [name, given, ...rest] = words;
	if (
		name === undefined ||
		name.startsWith('-') ||
		given?.startsWith('-') ||
		rest.length > 0
	)
		return fail(
			CliError.Usage({
				message: 'epicenter undo takes one app, and maybe the commit to undo',
				next: COMMANDS.undo,
			}).error,
			json,
		);
	const found = await appRepository(name);
	if ('error' in found) return fail(found.error, json);
	let done: Undone | { error: CliError };
	try {
		done = await undo(name, found.folder, given);
	} catch (error) {
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
