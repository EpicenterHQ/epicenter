/**
 * `epicenter sync [<app> [-m <message>]]` snapshots each of the app's two
 * repositories, its code and its data (ADR-0877), and pushes each to its own
 * `origin`, a private backup (ADR-0851). One app's failure never stops the
 * others. Without an app named, it then does the same for the Epicenter's
 * own repository (ADR-0884). `serve`'s backup clock runs the same `syncOne`
 * for each app, then `syncEpicenter`, and no other command pushes. Sharing an
 * app is pushing its code to a remote its author chooses, which nothing here
 * does.
 */
import { misuse, parseWords } from './commands.ts';
import { dataFolder } from './data.ts';
import { epicenterLabel, snapshotEpicenter } from './epicenter-repository.ts';
import { git, gitMessage, originOf } from './git.ts';
import { chooseApps } from './home.ts';
import { LOCK_WAIT_MS, locked } from './lock.ts';
import { fail, writeJson } from './output.ts';
import { epicenterDir } from './root.ts';
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

/**
 * Snapshot the Epicenter's own repository at `root`, recording the
 * repositories inside it, then push it to its `origin` as `syncOne` pushes an
 * app's; `null` when the Epicenter's folder is not a repository of its own.
 * Nothing else writes there, so it takes no lock.
 */
export async function syncEpicenter(
	root: string,
	message?: string,
): Promise<RepositorySynced | null> {
	const taken = await snapshotEpicenter(root, message);
	return taken && pushTo(epicenterLabel(root), root, taken);
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
	// Git never prompts (`git.ts`), and `serve` under a job has no terminal or SSH agent.
	const unanswered =
		/terminal prompts disabled|could not read (Username|Password)|Permission denied \(publickey|Host key verification failed/i.test(
			pushed.stderr,
		);
	return stop({
		message: `not pushed: ${gitMessage(args, pushed)}${unanswered ? '\nPushing needs a credential that works with no one to answer a prompt: an SSH key without a passphrase whose host is in ~/.ssh/known_hosts, or a Git credential helper that has stored one.' : ''}`,
		next: `git -C ${folder} push origin HEAD:${branch}`,
	});
}

/** One repository's sync as a person reads it. */
function syncLine(label: string, synced: RepositorySynced) {
	const parts = [
		synced.committed
			? `committed ${synced.committed.subject}`
			: 'nothing to commit',
		...(synced.pushed ? ['pushed'] : []),
		synced.origin ? `${synced.origin.ahead} ahead of origin` : 'no origin',
	];
	return `${label}: ${parts.join('; ')}`;
}

/** A sync as a person reads it: one line per repository on stdout, and what went wrong on stderr. */
function renderSync(
	apps: Synced[],
	epicenter?: { label: string; synced: RepositorySynced },
) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const failed = (failure: { message: string; next?: string }) =>
		stderr.push(
			failure.message,
			...(failure.next ? [`Run: ${failure.next}`] : []),
		);
	for (const app of apps) {
		const repositories = [
			[app.app, app.code],
			[`${app.app}/data`, app.data],
		] as const;
		for (const [label, synced] of repositories)
			if (synced) stdout.push(syncLine(label, synced));
		for (const failure of syncFailures(app)) failed(failure);
	}
	if (epicenter) {
		stdout.push(syncLine(epicenter.label, epicenter.synced));
		if (epicenter.synced.error) failed(epicenter.synced.error);
	}
	const lines = (all: string[]) => all.map((line) => `${line}\n`).join('');
	return { stdout: lines(stdout), stderr: lines(stderr) };
}

/**
 * `epicenter sync [<app> [-m <message>]]`: each app, or the one named, one
 * after another, answering `{ apps }` in name order; without a name, the
 * Epicenter's own repository after them, as `epicenter` in the answer when it
 * is one. 0 when every repository synced, 1 when any did not.
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
	const root = epicenterDir();
	const own = name === undefined ? await syncEpicenter(root) : null;
	if (json) writeJson({ apps, ...(own ? { epicenter: own } : {}) });
	else {
		const { stdout, stderr } = renderSync(
			apps,
			own ? { label: epicenterLabel(root), synced: own } : undefined,
		);
		process.stdout.write(stdout);
		process.stderr.write(stderr);
	}
	return apps.some((app) => syncFailures(app).length > 0) || own?.error ? 1 : 0;
}
