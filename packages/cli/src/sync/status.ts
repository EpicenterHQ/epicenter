/**
 * `epicenter status [<dir>]`: a thin read of the folder's Git state. It runs
 * `git status --porcelain` over what sync would commit (`COMMITTED`: the
 * folder, never its unfinished writes in `.epicenter`), compares `HEAD`
 * with the last fetched `origin/main`, and names whether the folder is
 * synced.
 * Without `<dir>` the command scans the library for synced folders.
 * It fetches nothing and writes nothing.
 */

import { realpath, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { config, git } from './git.ts';
import { repositoryRoot } from './setup.ts';
import { COMMITTED, MAGIC } from './sync.ts';

export type FolderStatus = {
	readonly folder: string;
	readonly repository: string;
	/** The branch `HEAD` names, or null when it is detached. */
	readonly branch: string | null;
	/** The commit `HEAD` is at, or null before the first commit. */
	readonly head: string | null;
	/** Whether this folder is its own repository with sync consent. */
	readonly adopted: boolean;
	/** Each changed path under the folder, relative to it, with its porcelain status. */
	readonly changes: { status: string; path: string }[];
	readonly remote: string | null;
	/** Commits `HEAD` has that the last fetched `origin/main` does not, and the reverse. */
	readonly ahead: number | null;
	readonly behind: number | null;
};

/** A folder whose status cannot be read, and why. */
export type FolderProblem = {
	readonly folder: string;
	readonly problem: string;
};

/** The status of a folder, or the reason it has none. */
export async function folderStatusOrProblem(
	folder: string,
): Promise<FolderStatus | FolderProblem> {
	try {
		await stat(folder);
	} catch (error) {
		const code =
			error instanceof Error && 'code' in error ? error.code : undefined;
		return {
			folder,
			problem:
				code === 'ENOENT'
					? 'not on disk'
					: code === 'EACCES' || code === 'EPERM'
						? 'unreadable'
						: error instanceof Error
							? error.message
							: String(error),
		};
	}
	try {
		return (
			(await folderStatus(folder)) ?? {
				folder,
				problem: 'not in a Git repository',
			}
		);
	} catch (error) {
		const code =
			error instanceof Error && 'code' in error ? error.code : undefined;
		return {
			folder,
			problem:
				code === 'EACCES' || code === 'EPERM'
					? 'unreadable'
					: error instanceof Error
						? error.message
						: String(error),
		};
	}
}

/** The status of the folder at `input`, or null when it is not in a repository. */
export async function folderStatus(
	input: string,
): Promise<FolderStatus | null> {
	const folder = resolve(input);
	const target = await realpath(folder);
	const root = await repositoryRoot(target);
	if (root === null) return null;
	const [branch, head, adopted, remote, porcelain, counts] = await Promise.all([
		git(root, ['symbolic-ref', '-q', '--short', 'HEAD']),
		git(root, ['rev-parse', '-q', '--verify', 'HEAD']),
		config(root, 'epicenter.synced'),
		config(root, 'remote.origin.url'),
		git(
			target,
			['status', '--porcelain=v1', '-z', '--untracked-files=all', ...COMMITTED],
			MAGIC,
		),
		git(root, [
			'rev-list',
			'--left-right',
			'--count',
			'HEAD...refs/remotes/origin/main',
		]),
	]);
	if (porcelain.code !== 0)
		throw new Error(
			/permission denied|operation not permitted/i.test(porcelain.stderr)
				? 'unreadable'
				: 'not in a Git repository',
		);
	const changes: { status: string; path: string }[] = [];
	const entries = porcelain.stdout.split('\0');
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i] as string;
		if (entry === '') continue;
		const status = entry.slice(0, 2);
		// Paths are relative to the repository; the status names them relative to the folder.
		changes.push({
			status,
			path: relative(target, resolve(root, entry.slice(3))),
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
		adopted: root === target && adopted === 'true',
		changes,
		remote,
		ahead: ahead ?? null,
		behind: behind ?? null,
	};
}
