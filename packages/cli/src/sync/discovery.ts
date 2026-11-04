/** Find repository candidates at the library root and one owner level down. */

import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAppPaths } from '../app-paths.ts';
import { git } from './git.ts';
import { repositoryRoot } from './setup.ts';

export type DiscoveredFolder = { folder: string; problem?: string };

async function localConfig(
	folder: string,
	key: string,
): Promise<string | null> {
	const result = await git(folder, ['config', '--local', '--get', key]);
	if (result.code === 0) return result.stdout.trim();
	if (result.code === 1) return null;
	throw new Error(result.stderr.trim() || 'not in a Git repository');
}

function reason(error: unknown): string {
	const code =
		error instanceof Error && 'code' in error ? error.code : undefined;
	if (code === 'ENOENT') return 'not on disk';
	if (code === 'EACCES' || code === 'EPERM') return 'unreadable';
	return error instanceof Error ? error.message : String(error);
}

async function children(
	folder: string,
	onError?: (error: unknown) => void,
): Promise<string[]> {
	try {
		return (await readdir(folder, { withFileTypes: true }))
			.filter(
				(entry) => !['.git', '.epicenter'].includes(entry.name.toLowerCase()),
			)
			.map((entry) => join(folder, entry.name))
			.sort();
	} catch (error) {
		onError?.(error);
		return [];
	}
}

/** One row per candidate. A bad entry cannot hide its siblings. */
export async function discoveredFolders(): Promise<DiscoveredFolder[]> {
	const found: DiscoveredFolder[] = [];
	const seen = new Set<string>();
	const inspect = async (folder: string, owner: boolean): Promise<void> => {
		let link = false;
		let target: string;
		try {
			const entry = await lstat(folder);
			link = entry.isSymbolicLink();
			if (!link && !entry.isDirectory()) return;
			target = await realpath(folder);
			if (!(await stat(target)).isDirectory()) {
				if (link) found.push({ folder, problem: 'not in a Git repository' });
				return;
			}
		} catch (error) {
			if (link) found.push({ folder, problem: reason(error) });
			return;
		}
		if (seen.has(target)) return;
		seen.add(target);
		let root: string | null = null;
		let gitProblem: string | undefined;
		try {
			root = await repositoryRoot(target);
		} catch (error) {
			gitProblem = reason(error);
		}
		if (root === target) {
			try {
				const synced = await localConfig(target, 'epicenter.synced');
				found.push({
					folder,
					...(synced === 'true'
						? {}
						: { problem: 'its repository is not set up for sync' }),
				});
			} catch (error) {
				found.push({ folder, problem: reason(error) });
			}
			return;
		}
		try {
			await lstat(join(target, '.git'));
			found.push({ folder, problem: gitProblem ?? 'not in a Git repository' });
			return;
		} catch (error) {
			if (reason(error) !== 'not on disk') {
				found.push({ folder, problem: reason(error) });
				return;
			}
		}
		if (owner) {
			if (link)
				found.push({
					folder,
					problem: gitProblem ?? 'not in a Git repository',
				});
			return;
		}
		const before = found.length;
		for (const child of await children(folder, (error) => {
			if (link) found.push({ folder, problem: reason(error) });
		}))
			await inspect(child, true);
		if (link && found.length === before)
			found.push({ folder, problem: gitProblem ?? 'not in a Git repository' });
	};
	for (const child of await children(resolveAppPaths().folderDir))
		await inspect(child, false);
	return found.sort((a, b) => a.folder.localeCompare(b.folder));
}
