/**
 * `epicenter sync [<app>]` commits, pulls, and pushes (ADR-0851). For each
 * app in the home, or the one named, from its folder:
 * commit whatever is left (`sync: <app> (<n> files)`), then
 * `git pull --rebase --autostash`, then `git push`. Which branch it pulls and
 * pushes is Git's: the upstream and `push.default` the clone already has, so
 * a branch that tracks nothing is committed and not pushed.
 *
 * A pull that stops on a conflict is aborted, so the folder is never left
 * mid-rebase; the commits stay local and the app's report names the next
 * step. One app's failure never stops the others. Sync reads no app's code.
 */
import { CliError } from './errors.ts';
import { commitFolder, git, gitMessage } from './git.ts';
import { homeEntries } from './home.ts';
import { fail, writeJson } from './output.ts';

/** What sync did for one app. */
export type Synced = {
	app: string;
	folder: string;
	/** The commit sync made of what was left, or `null` when nothing was. */
	committed: { subject: string; files: number } | null;
	pushed: boolean;
	/** How far the branch is from its upstream afterwards; `null` when it tracks none. */
	upstream: { ahead: number; behind: number } | null;
	/** Why this app did not finish syncing, and the command that resolves it. */
	error?: { message: string; next?: string };
};

/** What `epicenter sync` answers: one report per app, in name order. */
export type SyncAnswer = { apps: Synced[] };

/** Ahead and behind the upstream, or `null` when the branch tracks none. */
async function upstreamOf(folder: string) {
	const counted = await git(folder, [
		'rev-list',
		'--left-right',
		'--count',
		'HEAD...@{upstream}',
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
		upstream: null,
	};
	const stop = async (message: string, next?: string): Promise<Synced> => ({
		...synced,
		upstream: await upstreamOf(folder),
		error: { message: `${app}: ${message}`, ...(next ? { next } : {}) },
	});
	try {
		const subject = (files: number) =>
			`sync: ${app} (${files} ${files === 1 ? 'file' : 'files'})`;
		const files = await commitFolder(folder, subject);
		if (files > 0) synced.committed = { subject: subject(files), files };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return stop(
			message,
			message.endsWith('run: git lfs install') ? 'git lfs install' : undefined,
		);
	}
	if ((await upstreamOf(folder)) === null) return synced;
	const pullArgs = ['pull', '-q', '--rebase', '--autostash'];
	const pulled = await git(folder, pullArgs);
	if (pulled.code !== 0) {
		// A pull that stopped on a conflict leaves a rebase to abort; any other failure leaves none.
		const conflicted = (await git(folder, ['rebase', '--abort'])).code === 0;
		return stop(
			conflicted
				? 'pulling stopped on a conflict, so the pull was undone; your commits stay here and were not pushed'
				: `could not pull, so nothing was pushed: ${gitMessage(pullArgs, pulled)}`,
			`git -C ${folder} pull --rebase`,
		);
	}
	const output = `${pulled.stdout}\n${pulled.stderr}`;
	const pushArgs = ['push', '-q'];
	const pushedNow = await git(folder, pushArgs);
	if (pushedNow.code !== 0)
		return stop(
			`not pushed: ${gitMessage(pushArgs, pushedNow)}`,
			`git -C ${folder} push`,
		);
	synced.pushed = true;
	// `--autostash` says so when it cannot put changes back; Git keeps them in its stash.
	if (/safe in the stash/i.test(output))
		return stop(
			'uncommitted changes elsewhere in its repository could not be put back after pulling; Git kept them in its stash',
			`git -C ${folder} stash list`,
		);
	return { ...synced, upstream: await upstreamOf(folder) };
}

/** Sync every app in the home, or only `name`, one after another. */
export async function syncApps(
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
export function syncExitCode(answer: SyncAnswer) {
	return answer.apps.some((app) => app.error) ? 1 : 0;
}

/** A sync as a person reads it: one line per app on stdout, and what went wrong on stderr. */
export function renderSync(answer: SyncAnswer) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	for (const app of answer.apps) {
		const parts = [
			app.committed
				? `committed ${app.committed.subject}`
				: 'nothing to commit',
			...(app.pushed ? ['pushed'] : []),
			app.upstream
				? `${app.upstream.ahead} ahead, ${app.upstream.behind} behind`
				: 'no upstream',
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
