/**
 * `epicenter sync [<app> [-m <message>]]` snapshots and pushes to `origin`,
 * the home's optional backup (ADR-0851). One app's failure never stops the
 * others. `serve`'s backup clock runs the same `syncOne` for each app, and
 * no other command touches a remote.
 */
import { COMMANDS } from './commands.ts';
import { CliError } from './errors.ts';
import { git, gitMessage, originOf } from './git.ts';
import { homeEntries } from './home.ts';
import { fail, writeJson } from './output.ts';
import { snapshot } from './snapshot.ts';

/** What sync did for one app. */
export type Synced = {
	app: string;
	folder: string;
	/** The snapshot sync took of what was pending, or `null` when nothing was. */
	committed: { subject: string; files: number } | null;
	pushed: boolean;
	/** How many commits the branch is ahead of its locally known `origin` tracking ref; `null` when there is none. */
	origin: { ahead: number } | null;
	/** Why this app did not finish syncing, and the command that resolves it. */
	error?: { message: string; next?: string };
};

/** What `epicenter sync` answers: one report per app, in name order. */
type SyncAnswer = { apps: Synced[] };

/** How far the branch is ahead of `origin`, as `Synced` reports it. */
async function aheadOf(folder: string) {
	const ahead = (await originOf(folder))?.ahead;
	return ahead === undefined ? null : { ahead };
}

/**
 * Snapshot what is pending in one app, as `<app>: <message>` or `<app>:
 * changed outside epicenter`, then, when it has `origin`, push the branch
 * there by name if it is ahead of its tracking ref or has none yet. It never
 * fetches, merges, or force pushes, and never pushes to `upstream`
 * (ADR-0851). `epicenter sync` and `serve`'s clock both run it; nothing else
 * touches a remote.
 */
export async function syncOne(
	app: string,
	folder: string,
	message?: string,
): Promise<Synced> {
	const synced: Synced = {
		app,
		folder,
		committed: null,
		pushed: false,
		origin: null,
	};
	const stop = async (failure: {
		message: string;
		next?: string;
	}): Promise<Synced> => ({
		...synced,
		origin: await aheadOf(folder),
		error: {
			message: `${app}: ${failure.message}`,
			...(failure.next ? { next: failure.next } : {}),
		},
	});
	const insideArgs = ['rev-parse', '--is-inside-work-tree'];
	const inside = await git(folder, insideArgs);
	if (inside.code !== 0) return stop({ message: gitMessage(insideArgs, inside) });
	const taken = await snapshot(app, folder, { message });
	if ('failed' in taken) return stop(taken.failed);
	synced.committed = taken.committed;
	const origin = await originOf(folder);
	if (!origin) return synced;
	const { branch, ahead } = origin;
	if (branch === '')
		return stop({ message: 'is not on a branch, so nothing was pushed' });
	if (ahead === 0) return { ...synced, origin: { ahead } };
	const args = ['push', 'origin', `HEAD:${branch}`];
	const pushed = await git(folder, args);
	if (pushed.code === 0)
		return { ...synced, pushed: true, origin: await aheadOf(folder) };
	if (
		/non-fast-forward|\[rejected\].*fetch first/i.test(pushed.stderr)
	)
		return stop({
			message:
				'the backup at origin has changes this computer does not; nothing was overwritten',
			next: `git -C ${folder} fetch origin && git -C ${folder} log HEAD..origin/${branch}`,
		});
	return stop({
		message: `not pushed: ${gitMessage(args, pushed)}`,
		next: `git -C ${folder} push origin HEAD:${branch}`,
	});
}

/** Sync every app in the Epicenter, or only `name`, one after another. */
async function syncApps(
	name?: string,
	message?: string,
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
		apps.push(await syncOne(entry, realPath, message));
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
			app.origin ? `${app.origin.ahead} ahead of origin` : 'no origin',
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

/**
 * The app and message `epicenter sync` was given: at most one app, and
 * `--message <text>`, `--message=<text>`, or `-m <text>` only with an app;
 * `undefined` when the words say anything else.
 */
function syncWords(words: string[]) {
	const [name, ...rest] = words;
	if (name === undefined) return {};
	if (name.startsWith('-')) return undefined;
	if (rest.length === 0) return { name };
	const [flag = '', value] = rest;
	if (flag.startsWith('--message='))
		return rest.length === 1
			? { name, message: flag.slice('--message='.length) }
			: undefined;
	if ((flag === '--message' || flag === '-m') && rest.length === 2)
		return { name, message: value };
	return undefined;
}

/** `epicenter sync [<app> [-m <message>]]`. */
export async function syncCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const given = syncWords(words);
	if (!given)
		return fail(
			CliError.Usage({
				message:
					'epicenter sync takes at most one app, and with it maybe -m <message>',
				next: COMMANDS.sync,
			}).error,
			json,
		);
	const { name, message } = given;
	if (
		message !== undefined &&
		(message.trim() === '' || /[\r\n]/.test(message))
	)
		return fail(
			CliError.Usage({
				message: 'A sync message is one line of text, saying what changed',
				next: COMMANDS.sync,
			}).error,
			json,
		);
	const answer = await syncApps(name, message);
	if ('error' in answer) return fail(answer.error, json);
	if (json) writeJson(answer);
	else {
		const { stdout, stderr } = renderSync(answer);
		process.stdout.write(stdout);
		process.stderr.write(stderr);
	}
	return syncExitCode(answer);
}
