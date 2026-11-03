/** Find synced app repositories at the library root and one owner level down. */

import { readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAppPaths } from '../app-paths.ts';
import { config } from './git.ts';
import { repositoryRoot } from './setup.ts';

async function children(folder: string): Promise<string[]> {
	const entries = await readdir(folder, { withFileTypes: true }).catch(
		(error: unknown) => {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
				return [];
			throw error;
		},
	);
	const directories: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		const path = join(folder, entry.name);
		if (
			entry.isDirectory() ||
			(entry.isSymbolicLink() &&
				(await stat(path).catch(() => null))?.isDirectory())
		)
			directories.push(path);
	}
	return directories.sort();
}

/** The library paths whose own local Git configuration consents to sync. */
export async function syncedFolders(): Promise<string[]> {
	const library = resolveAppPaths().folderDir;
	const found: string[] = [];
	const seen = new Set<string>();
	for (const child of await children(library)) {
		const target = await realpath(child).catch(() => null);
		if (target === null) continue;
		const root = await repositoryRoot(target);
		if (root === target) {
			if (
				(await config(target, 'epicenter.synced')) === 'true' &&
				!seen.has(target)
			) {
				found.push(child);
				seen.add(target);
			}
			continue;
		}
		// A child inside another work tree belongs to that app, not an owner.
		if (root !== null) continue;
		for (const app of await children(child)) {
			const appTarget = await realpath(app).catch(() => null);
			if (appTarget === null || seen.has(appTarget)) continue;
			if (
				(await repositoryRoot(appTarget)) === appTarget &&
				(await config(appTarget, 'epicenter.synced')) === 'true'
			) {
				found.push(app);
				seen.add(appTarget);
			}
		}
	}
	return found;
}
