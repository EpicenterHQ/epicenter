/**
 * `epicenter sync [<app>]` snapshots and pushes to `origin`, the home's
 * optional backup (ADR-0851). One app's failure never stops the others.
 */
import { CliError } from './errors.ts';
import { git, gitMessage } from './git.ts';
import { homeEntries } from './home.ts';
import { fail, writeJson } from './output.ts';
import { pushOrigin } from './push.ts';
import { snapshot } from './snapshot.ts';

/** What sync did for one app. */
type Synced = {
	app: string;
	folder: string;
	/** The snapshot sync took of what was pending, or `null` when nothing was. */
	committed: { subject: string; files: number } | null;
	pushed: boolean;
	/** How far the branch is from the locally known `origin` tracking ref; `null` when there is none. */
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
	const pushedNow = await pushOrigin(folder);
	if ('noOrigin' in pushedNow) return synced;
	if ('error' in pushedNow)
		return stop(pushedNow.error.message, pushedNow.error.next);
	synced.pushed = pushedNow.pushed;
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
