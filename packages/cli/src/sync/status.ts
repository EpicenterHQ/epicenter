/**
 * `epicenter status [<dir>]`: a thin read of the folder's Git state. It runs
 * `git status --porcelain` limited to the folder, compares `HEAD` with the
 * last fetched `origin/main`, and names whether the folder is registered.
 * It fetches nothing and writes nothing.
 */

import { realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { config, git } from './git.ts';
import { registeredFolders, repositoryRoot } from './setup.ts';

export type FolderStatus = {
	readonly folder: string;
	readonly repository: string;
	/** The branch `HEAD` names, or null when it is detached. */
	readonly branch: string | null;
	/** The commit `HEAD` is at, or null before the first commit. */
	readonly head: string | null;
	readonly registered: boolean;
	/** Whether `epicenter init` adopted the repository, so sync will run. */
	readonly adopted: boolean;
	/** Each changed path under the folder, relative to it, with its porcelain status. */
	readonly changes: { status: string; path: string }[];
	readonly remote: string | null;
	/** Commits `HEAD` has that the last fetched `origin/main` does not, and the reverse. */
	readonly ahead: number | null;
	readonly behind: number | null;
};

/** The status of the folder at `input`, or null when it is not in a repository. */
export async function folderStatus(
	input: string,
): Promise<FolderStatus | null> {
	const folder = await realpath(resolve(input));
	const root = await repositoryRoot(folder);
	if (root === null) return null;
	const [branch, head, adopted, remote, registered, porcelain, counts] =
		await Promise.all([
			git(root, ['symbolic-ref', '-q', '--short', 'HEAD']),
			git(root, ['rev-parse', '-q', '--verify', 'HEAD']),
			config(root, 'epicenter.root'),
			config(root, 'remote.origin.url'),
			registeredFolders(),
			git(
				root,
				[
					'status',
					'--porcelain=v1',
					'-z',
					'--untracked-files=all',
					'--',
					relative(root, folder) || '.',
				],
				// The folder's path names only itself, whatever characters it holds.
				{ env: { GIT_LITERAL_PATHSPECS: '1' } },
			),
			git(root, [
				'rev-list',
				'--left-right',
				'--count',
				'HEAD...refs/remotes/origin/main',
			]),
		]);
	const changes: { status: string; path: string }[] = [];
	const entries = porcelain.stdout.split('\0');
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i] as string;
		if (entry === '') continue;
		const status = entry.slice(0, 2);
		// Paths are relative to the repository; the status names them relative to the folder.
		changes.push({
			status,
			path: relative(folder, resolve(root, entry.slice(3))),
		});
		// A rename or copy carries its old path in the next entry.
		if (/[RC]/.test(status)) i++;
	}
	const [ahead, behind] =
		counts.code === 0
			? counts.stdout.trim().split(/\s+/).map(Number)
			: [null, null];
	return {
		folder,
		repository: root,
		branch: branch.code === 0 ? branch.stdout.trim() : null,
		head: head.code === 0 ? head.stdout.trim() : null,
		registered: registered.includes(folder),
		adopted: adopted === root,
		changes,
		remote,
		ahead: ahead ?? null,
		behind: behind ?? null,
	};
}
