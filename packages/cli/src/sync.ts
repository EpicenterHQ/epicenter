/**
 * `epicenter sync [<app> [-m <message>]]` snapshots each of the app's two
 * repositories, its code and its data (ADR-0877), and pushes each to its own
 * `origin`, a private backup (ADR-0851). One app's failure never stops the
 * others. `serve`'s backup clock runs the same `syncOne` for each app, and
 * no other command pushes. Sharing an app is pushing its code to a remote
 * its author chooses, which nothing here does.
 */
import { misuse, parseWords } from './commands.ts';
import { dataFolder } from './data.ts';
import { git, gitMessage, originOf } from './git.ts';
import { chooseApps } from './home.ts';
import { LOCK_WAIT_MS, locked } from './lock.ts';
import { fail, writeJson } from './output.ts';
import { type Snapshot, snapshotApp } from './snapshot.ts';

/** What sync did in one of an app's repositories. */
export type RepositorySynced = {
	/** The snapshot sync took of what was pending, or `null` when nothing was. */
	committed: { subject: string; files: number } | null;
	pushed: boolean;
	/** How many commits the branch is ahead of its locally known `origin` tracking ref; `null` when there is none. */
	origin: { ahead: number } | null;
	/** Why this repository did not finish syncing, and the command that resolves it. */
	error?: { message: string; next?: string };
};

/**
 * What sync did for one app: in its code and its data, each `null` when the
 * app does not have that repository; `busy` when a call to it was still
 * running, so nothing was snapshotted or pushed.
 */
export type Synced = {
	app: string;
	folder: string;
	code: RepositorySynced | null;
	data: RepositorySynced | null;
	busy?: true;
};

/** Every failure in a sync, each naming its repository, with the step that resolves it. */
export function syncFailures(synced: Synced) {
	if (synced.busy)
		return [
			{
				message: `${synced.app}: a call is still writing it, so nothing was snapshotted or pushed`,
			},
		];
	return [synced.code?.error, synced.data?.error].filter(
		(error) => error !== undefined,
	);
}

/** How far the branch is ahead of `origin`, as `RepositorySynced` reports it. */
async function aheadOf(folder: string) {
	const ahead = (await originOf(folder))?.ahead;
	return ahead === undefined ? null : { ahead };
}

/**
 * Snapshot what is pending in both of the app's repositories, as
 * `<app>: <message>` or `<app>: changed outside epicenter`, then push each
 * that has `origin` there by name, if it is ahead of its tracking ref or has
 * none yet. It never fetches, merges, or force pushes, and never pushes to
 * `upstream` or any other remote (ADR-0851). The snapshots hold the app's
 * lock, waiting up to `wait` milliseconds (30 seconds unless given) for a call
 * writing the app to commit; `serve`'s clock gives 0. The pushes hold nothing.
 */
export async function syncOne(
	app: string,
	folder: string,
	{ message, wait }: { message?: string; wait?: number } = {},
): Promise<Synced> {
	const ran = await locked(folder, wait ?? LOCK_WAIT_MS, () =>
		snapshotApp(app, folder, message),
	);
	if ('busy' in ran) return { app, folder, code: null, data: null, busy: true };
	const { code, data } = ran.done;
	return {
		app,
		folder,
		code: code && (await pushTo(app, folder, code)),
		data: data && (await pushTo(`${app}/data`, dataFolder(folder), data)),
	};
}

/** After `taken`, push the repository at `folder`, which messages call `label`, to its `origin`. */
async function pushTo(
	label: string,
	folder: string,
	taken: Snapshot,
): Promise<RepositorySynced> {
	const synced: RepositorySynced = {
		committed: null,
		pushed: false,
		origin: null,
	};
	const stop = async (failure: {
		message: string;
		next?: string;
	}): Promise<RepositorySynced> => ({
		...synced,
		origin: await aheadOf(folder),
		error: {
			message: `${label}: ${failure.message}`,
			...(failure.next ? { next: failure.next } : {}),
		},
	});
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
	if (/non-fast-forward|\[rejected\].*fetch first/i.test(pushed.stderr))
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

/** A sync as a person reads it: one line per repository on stdout, and what went wrong on stderr. */
function renderSync(apps: Synced[]) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	for (const app of apps) {
		const repositories = [
			[app.app, app.code],
			[`${app.app}/data`, app.data],
		] as const;
		for (const [label, synced] of repositories) {
			if (!synced) continue;
			const parts = [
				synced.committed
					? `committed ${synced.committed.subject}`
					: 'nothing to commit',
				...(synced.pushed ? ['pushed'] : []),
				synced.origin ? `${synced.origin.ahead} ahead of origin` : 'no origin',
			];
			stdout.push(`${label}: ${parts.join('; ')}`);
		}
		for (const failure of syncFailures(app))
			stderr.push(
				failure.message,
				...(failure.next ? [`Run: ${failure.next}`] : []),
			);
	}
	const lines = (all: string[]) => all.map((line) => `${line}\n`).join('');
	return { stdout: lines(stdout), stderr: lines(stderr) };
}

/**
 * `epicenter sync [<app> [-m <message>]]`: each app, or the one named, one
 * after another, answering `{ apps }` in name order. 0 when every app
 * synced, 1 when any did not.
 */
export async function syncCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const given = parseWords(
		words,
		{ message: { type: 'string', short: 'm' } },
		[0, 1],
	);
	const [name] = given?.positionals ?? [];
	const message = given?.values.message;
	if (!given || (message !== undefined && name === undefined))
		return fail(misuse('sync'), json);
	if (
		message !== undefined &&
		(message.trim() === '' || /[\r\n]/.test(message))
	)
		return fail(
			misuse('sync', 'A sync message is one line of text, saying what changed'),
			json,
		);
	const { data: chosen, error } = await chooseApps(name);
	if (error) return fail(error, json);
	const apps: Synced[] = [];
	for (const { entry, realPath } of chosen)
		apps.push(await syncOne(entry, realPath, { message }));
	if (json) writeJson({ apps });
	else {
		const { stdout, stderr } = renderSync(apps);
		process.stdout.write(stdout);
		process.stderr.write(stderr);
	}
	return apps.some((app) => syncFailures(app).length > 0) ? 1 : 0;
}
