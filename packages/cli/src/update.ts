/**
 * `epicenter update [<app>]` brings a starter's changes into each app made
 * from it (ADR-0866). For each app with an `upstream` remote, or the one
 * named:
 *
 * 1. `git fetch upstream`, which touches only Git's own records;
 * 2. holding the app's lock (`lock.ts`), snapshot what is pending, as `undo`
 *    does, so the merge never mixes with it, then merge the branch
 *    `upstream/HEAD` names, as `<app>: update from upstream`; a conflict
 *    aborts the merge, leaving the app as it was, and names the command that
 *    resolves it;
 * 3. check that the merged `epicenter.ts` loads;
 * 4. build the UI, keeping the last one that built if this build fails.
 *
 * Neither the fetch nor the build holds the lock, so the network and a build
 * never keep a call from writing the app.
 *
 * Git merges code and does not migrate data: a file that no longer fits its
 * collection's fields says so in the `problems` of every read. An app
 * without `upstream` is reported and left alone. One app's failure never
 * stops the others.
 */
import { extractErrorMessage } from 'wellcrafted/error';
import { misuse, parseWords } from './commands.ts';
import { git, gitMessage } from './git.ts';
import { chooseApps, loadHomeApp } from './home.ts';
import { LOCK_WAIT_MS, locked } from './lock.ts';
import { fail, writeJson } from './output.ts';
import { snapshot } from './snapshot.ts';
import { buildUi } from './ui.ts';

/** What update did for one app. */
type Updated = {
	app: string;
	folder: string;
	/** Whether the app has an `upstream` remote; an app without one is left alone. */
	upstream: boolean;
	/** The merge commit, or `null` when the app already had everything. */
	merged: string | null;
	/** Whether a UI was built; `false` when `ui/package.json` has no `build` script. */
	built: boolean;
	/** Why this app did not finish updating, and the command that resolves it. */
	error?: { message: string; next?: string };
};

async function updateOne(app: string, folder: string): Promise<Updated> {
	const updated: Updated = {
		app,
		folder,
		upstream: false,
		merged: null,
		built: false,
	};
	if ((await git(folder, ['remote', 'get-url', 'upstream'])).code !== 0)
		return updated;
	updated.upstream = true;
	const stop = (message: string, next?: string): Updated => ({
		...updated,
		error: { message: `${app}: ${message}`, ...(next ? { next } : {}) },
	});
	const stopped = (message: string, next?: string) => ({
		stopped: stop(message, next),
	});
	const fetchArgs = ['fetch', '-q', 'upstream'];
	const fetched = await git(folder, fetchArgs);
	if (fetched.code !== 0)
		return stop(`could not fetch: ${gitMessage(fetchArgs, fetched)}`);
	const branch = (
		await git(folder, ['rev-parse', '--abbrev-ref', 'upstream/HEAD'])
	).stdout;
	const target = branch !== '' && branch !== 'upstream/HEAD' ? branch : '';
	if (target === '')
		return stop(
			'upstream names no default branch; set it with git remote set-head upstream --auto',
			`git -C ${folder} remote set-head upstream --auto`,
		);
	const ran = await locked(folder, LOCK_WAIT_MS, async () => {
		const taken = await snapshot(app, folder);
		if ('failed' in taken)
			return stopped(
				`nothing was merged, since what is pending could not be snapshotted first: ${taken.failed.message}`,
				taken.failed.next ?? `epicenter sync ${app}`,
			);
		const mergeArgs = [
			'merge',
			'-q',
			'--no-edit',
			'-m',
			`${app}: update from upstream`,
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
			`epicenter update ${app}`,
		);
	if ('stopped' in ran.done) return ran.done.stopped;
	updated.merged = ran.done.merged;
	const { data: located, error } = await loadHomeApp(app);
	if (error) return stop(error.message);
	if (!located.ok) return stop(located.problems.join('; '));
	try {
		updated.built = await buildUi(folder);
	} catch (error) {
		return stop(
			`the UI did not build, so the last one that did is kept: ${extractErrorMessage(error)}`,
		);
	}
	return updated;
}

/** A person's reading of an update: one line per app, problems on stderr. */
function render(apps: Updated[]) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	for (const app of apps) {
		if (!app.upstream) {
			stdout.push(`${app.app}: no upstream; left alone`);
			continue;
		}
		stdout.push(
			`${app.app}: ${[
				app.merged ? `merged ${app.merged}` : 'already up to date',
				...(app.built ? ['UI built'] : []),
			].join('; ')}`,
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

/** `epicenter update [<app>]`: 0 when every app updated, 1 when any did not. */
export async function updateCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const given = parseWords(words, {}, [0, 1]);
	if (!given) return fail(misuse('update'), json);
	const { data: chosen, error } = await chooseApps(given.positionals[0]);
	if (error) return fail(error, json);
	const apps: Updated[] = [];
	for (const { entry, realPath } of chosen)
		apps.push(await updateOne(entry, realPath));
	if (json) writeJson({ apps });
	else {
		const { stdout, stderr } = render(apps);
		process.stdout.write(stdout);
		process.stderr.write(stderr);
	}
	return apps.some((app) => app.error) ? 1 : 0;
}
