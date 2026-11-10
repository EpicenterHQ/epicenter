/**
 * `epicenter sync [<app>]` snapshots, pulls, and pushes to `origin`, the
 * app's backup or its server (ADR-0851, ADR-0866). For each app in the
 * Epicenter, or the one named, from its folder: take a snapshot of whatever
 * is pending (`snapshot.ts`); then, when the app has an `origin`, fetch it,
 * rebase onto `origin`'s copy of the branch when there is one, and push the
 * branch to `origin` by name. It never pushes to `upstream`, the starter an
 * app came from, nor to whatever the branch tracks.
 *
 * A rebase that stops on a conflict is aborted, so the folder is never left
 * mid-rebase; the commits stay local and the app's report names the next
 * step. One app's failure never stops the others. Sync reads no app's code.
 */
import { CliError } from './errors.ts';
import { git, gitMessage } from './git.ts';
import { homeEntries } from './home.ts';
import { fail, writeJson } from './output.ts';
import { snapshot } from './snapshot.ts';

/** What sync did for one app. */
type Synced = {
	app: string;
	folder: string;
	/** The snapshot sync took of what was pending, or `null` when nothing was. */
	committed: { subject: string; files: number } | null;
	pushed: boolean;
	/** How far the branch is from `origin`'s copy of it afterwards; `null` when there is none. */
	origin: { ahead: number; behind: number } | null;
	/** Why this app did not finish syncing, and the command that resolves it. */
	error?: { message: string; next?: string };
};

/** What `epicenter sync` answers: one report per app, in name order. */
type SyncAnswer = { apps: Synced[] };

/** The branch checked out, as `origin` would name it; empty on a detached HEAD. */
async function branchOf(folder: string) {
	return (await git(folder, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout;
}

/** Ahead and behind `origin`'s copy of the branch, or `null` when it has none. */
async function originOf(folder: string) {
	const branch = await branchOf(folder);
	if (branch === '') return null;
	const counted = await git(folder, [
		'rev-list',
		'--left-right',
		'--count',
		`HEAD...refs/remotes/origin/${branch}`,
	]);
	if (counted.code !== 0) return null;
	const [ahead = 0, behind = 0] = counted.stdout.split(/\s+/).map(Number);
	return { ahead, behind };
}

async function syncOne(app: string, folder: string): Promise<Synced> {
	const synced: Synced = {
		app,
		folder,
		committed: null,
		pushed: false,
		origin: null,
	};
	const stop = async (message: string, next?: string): Promise<Synced> => ({
		...synced,
		origin: await originOf(folder),
		error: { message: `${app}: ${message}`, ...(next ? { next } : {}) },
	});
	const insideArgs = ['rev-parse', '--is-inside-work-tree'];
	const inside = await git(folder, insideArgs);
	if (inside.code !== 0) return stop(gitMessage(insideArgs, inside));
	const taken = await snapshot(app, folder);
	if ('failed' in taken)
		return stop(
			taken.failed,
			taken.failed.endsWith('run: git lfs install')
				? 'git lfs install'
				: undefined,
		);
	synced.committed = taken.committed;
	if ((await git(folder, ['remote', 'get-url', 'origin'])).code !== 0)
		return synced;
	const branch = await branchOf(folder);
	if (branch === '') return stop('is not on a branch, so nothing was pushed');
	const fetchArgs = ['fetch', '-q', 'origin'];
	const fetched = await git(folder, fetchArgs);
	if (fetched.code !== 0)
		return stop(
			`could not fetch, so nothing was pushed: ${gitMessage(fetchArgs, fetched)}`,
			`git -C ${folder} fetch origin`,
		);
	let output = '';
	const remote = `refs/remotes/origin/${branch}`;
	if ((await git(folder, ['rev-parse', '-q', '--verify', remote])).code === 0) {
		const rebaseArgs = ['rebase', '-q', '--autostash', remote];
		const rebased = await git(folder, rebaseArgs);
		if (rebased.code !== 0) {
			// A rebase that stopped on a conflict is left to abort; any other failure leaves none.
			const conflicted = (await git(folder, ['rebase', '--abort'])).code === 0;
			return stop(
				conflicted
					? 'pulling stopped on a conflict, so the pull was undone; your commits stay here and were not pushed'
					: `could not pull, so nothing was pushed: ${gitMessage(rebaseArgs, rebased)}`,
				`git -C ${folder} pull --rebase origin ${branch}`,
			);
		}
		output = `${rebased.stdout}\n${rebased.stderr}`;
	}
	const pushArgs = ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`];
	const pushedNow = await git(folder, pushArgs);
	if (pushedNow.code !== 0)
		return stop(
			`not pushed: ${gitMessage(pushArgs, pushedNow)}`,
			`git -C ${folder} push origin ${branch}`,
		);
	synced.pushed = true;
	// `--autostash` says so when it cannot put changes back; Git keeps them in its stash.
	if (/safe in the stash/i.test(output))
		return stop(
			'uncommitted changes elsewhere in its repository could not be put back after pulling; Git kept them in its stash',
			`git -C ${folder} stash list`,
		);
	return { ...synced, origin: await originOf(folder) };
}

/** Sync every app in the Epicenter, or only `name`, one after another. */
async function syncApps(
	name?: string,
): Promise<{ error: CliError } | SyncAnswer> {
	const entries = await homeEntries();
	const chosen =
		name === undefined
			? entries
			: entries.filter((entry) => entry.entry === name);
	if (name !== undefined && chosen.length === 0)
		return {
			error: CliError.Usage({
				message: `Unknown app "${name}"`,
				next: 'epicenter',
			}).error,
		};
	const apps: Synced[] = [];
	for (const { entry, realPath } of chosen)
		apps.push(await syncOne(entry, realPath));
	return { apps };
}

/** 0 when every app synced, 1 when any did not. */
function syncExitCode(answer: SyncAnswer) {
	return answer.apps.some((app) => app.error) ? 1 : 0;
}

/** A sync as a person reads it: one line per app on stdout, and what went wrong on stderr. */
function renderSync(answer: SyncAnswer) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	for (const app of answer.apps) {
		const parts = [
			app.committed
				? `committed ${app.committed.subject}`
				: 'nothing to commit',
			...(app.pushed ? ['pushed'] : []),
			app.origin
				? `${app.origin.ahead} ahead of origin, ${app.origin.behind} behind`
				: 'no origin',
		];
		stdout.push(`${app.app}: ${parts.join('; ')}`);
		if (app.error)
			stderr.push(
				app.error.message,
				...(app.error.next ? [`Run: ${app.error.next}`] : []),
			);
	}
	const lines = (all: string[]) => all.map((line) => `${line}\n`).join('');
	return { stdout: lines(stdout), stderr: lines(stderr) };
}

/** `epicenter sync [<app>]`. */
export async function syncCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	if (words.length > 1)
		return fail(
			CliError.Usage({ message: 'epicenter sync takes at most one app' }).error,
			json,
		);
	const answer = await syncApps(words[0]);
	if ('error' in answer) return fail(answer.error, json);
	if (json) writeJson(answer);
	else {
		const { stdout, stderr } = renderSync(answer);
		process.stdout.write(stdout);
		process.stderr.write(stderr);
	}
	return syncExitCode(answer);
}
