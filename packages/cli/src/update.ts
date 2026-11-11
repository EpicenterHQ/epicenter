/**
 * `epicenter update [<app> [<remote>]]` brings a starter's changes into each
 * app made from it (ADR-0866), working in the app's code repository; its data
 * is a repository of its own that no merge touches (ADR-0877). For each app
 * with an `upstream` remote, or the one named, from `upstream` or the remote
 * named (an author takes back a change someone made in their copy the same
 * way):
 *
 * 1. fetch the remote, which touches only Git's own records, and learn its
 *    default branch when Git does not know it yet;
 * 2. holding the app's lock (`lock.ts`), snapshot what is pending in its code
 *    and its data, as `undo` does, so the merge never mixes with it, then
 *    merge the branch `<remote>/HEAD` names, as `<app>: update from
 *    <remote>`; a conflict aborts the merge, leaving the app as it was, and
 *    names the command that resolves it;
 * 3. check that the merged `epicenter.ts` loads.
 *
 * The fetch does not hold the lock, so the network never keeps a call from
 * writing the app. `serve` rebuilds the UI from the merged code.
 *
 * Git merges code and does not migrate data: a field the merge renames or
 * tightens is repaired in the data by an action or an agent, in data commits
 * that name the merged code. An app without the remote is reported and left
 * alone. One app's failure never stops the others.
 */
import { misuse, parseWords } from './commands.ts';
import { git, gitMessage } from './git.ts';
import { chooseApps, loadHomeApp } from './home.ts';
import { LOCK_WAIT_MS, locked } from './lock.ts';
import { fail, writeJson } from './output.ts';
import { failureOf, snapshotApp } from './snapshot.ts';

/** What update did for one app. */
type Updated = {
	app: string;
	folder: string;
	/** The remote it merges from, `upstream` unless one was named. */
	remote: string;
	/** Whether the app has that remote; an app without it is left alone. */
	found: boolean;
	/** The merge commit, or `null` when the app already had everything. */
	merged: string | null;
	/** Why this app did not finish updating, and the command that resolves it. */
	error?: { message: string; next?: string };
};

async function updateOne(
	app: string,
	folder: string,
	remote: string,
): Promise<Updated> {
	const updated: Updated = {
		app,
		folder,
		remote,
		found: false,
		merged: null,
	};
	if ((await git(folder, ['remote', 'get-url', remote])).code !== 0)
		return updated;
	updated.found = true;
	const stop = (message: string, next?: string): Updated => ({
		...updated,
		error: { message: `${app}: ${message}`, ...(next ? { next } : {}) },
	});
	const stopped = (message: string, next?: string) => ({
		stopped: stop(message, next),
	});
	const fetchArgs = ['fetch', '-q', remote];
	const fetched = await git(folder, fetchArgs);
	if (fetched.code !== 0)
		return stop(`could not fetch: ${gitMessage(fetchArgs, fetched)}`);
	const defaultBranch = async () => {
		const branch = (
			await git(folder, ['rev-parse', '--abbrev-ref', `${remote}/HEAD`])
		).stdout;
		return branch !== '' && branch !== `${remote}/HEAD` ? branch : '';
	};
	let target = await defaultBranch();
	if (target === '') {
		await git(folder, ['remote', 'set-head', remote, '--auto']);
		target = await defaultBranch();
	}
	if (target === '')
		return stop(
			`${remote} names no default branch`,
			`git -C ${folder} remote set-head ${remote} <branch>`,
		);
	const ran = await locked(folder, LOCK_WAIT_MS, async () => {
		const failed = failureOf(await snapshotApp(app, folder));
		if (failed)
			return stopped(
				`nothing was merged, since what is pending could not be snapshotted first: ${failed.message}`,
				failed.next ?? `epicenter sync ${app}`,
			);
		const mergeArgs = [
			'merge',
			'-q',
			'--no-edit',
			'-m',
			`${app}: update from ${remote}`,
			target,
		];
		const before = (await git(folder, ['rev-parse', 'HEAD'])).stdout;
		const merging = await git(folder, mergeArgs);
		if (merging.code === 0)
			return {
				merged:
					(await git(folder, ['rev-parse', 'HEAD'])).stdout === before
						? null
						: (await git(folder, ['rev-parse', '--short', 'HEAD'])).stdout,
			};
		const aborted = (await git(folder, ['merge', '--abort'])).code === 0;
		return stopped(
			aborted
				? 'the merge stopped on a conflict, so it was undone; the app is as it was'
				: `could not merge: ${gitMessage(mergeArgs, merging)}`,
			`git -C ${folder} merge ${target}`,
		);
	});
	if ('busy' in ran)
		return stop(
			'nothing was merged, since a call is still writing it',
			`epicenter update ${app}${remote === 'upstream' ? '' : ` ${remote}`}`,
		);
	if ('stopped' in ran.done) return ran.done.stopped;
	updated.merged = ran.done.merged;
	const { data: located, error } = await loadHomeApp(app);
	if (error) return stop(error.message);
	if (!located.ok) return stop(located.problems.join('; '));
	return updated;
}

/** A person's reading of an update: one line per app, problems on stderr. */
function render(apps: Updated[]) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	for (const app of apps) {
		if (!app.found) {
			stdout.push(`${app.app}: no ${app.remote}; left alone`);
			continue;
		}
		stdout.push(
			`${app.app}: ${app.merged ? `merged ${app.merged}` : 'already up to date'}`,
		);
		if (app.error)
			stderr.push(
				app.error.message,
				...(app.error.next ? [`Run: ${app.error.next}`] : []),
			);
	}
	const lines = (all: string[]) => all.map((line) => `${line}\n`).join('');
	return { stdout: lines(stdout), stderr: lines(stderr) };
}

/** `epicenter update [<app> [<remote>]]`: 0 when every app updated, 1 when any did not. */
export async function updateCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const given = parseWords(words, {}, [0, 2]);
	if (!given) return fail(misuse('update'), json);
	const [name, remote = 'upstream'] = given.positionals;
	const { data: chosen, error } = await chooseApps(name);
	if (error) return fail(error, json);
	const apps: Updated[] = [];
	for (const { entry, realPath } of chosen)
		apps.push(await updateOne(entry, realPath, remote));
	if (json) writeJson({ apps });
	else {
		const { stdout, stderr } = render(apps);
		process.stdout.write(stdout);
		process.stderr.write(stderr);
	}
	return apps.some((app) => app.error) ? 1 : 0;
}
