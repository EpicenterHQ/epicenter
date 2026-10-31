/**
 * What the native Bun folder keeps in its directory's own `.epicenter`
 * (`STATE_DIRECTORY`), which no listing shows and no watcher reports: the
 * scratch directory where a new file's bytes are staged. It needs no Git, so
 * a directory without `.git`, or with a `.git` file or link, opens and saves
 * alike, and saving creates nothing beside it and nothing in it but the
 * files saved and `.epicenter`.
 *
 * The scratch directory is `.epicenter/scratch`, on the directory's own file
 * system, so the rename over a path is one step. A link at `.epicenter` is
 * never followed.
 */
import { lstat, realpath } from 'node:fs/promises';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { STATE_DIRECTORY } from '../boundary.js';
import { nodeDirectoryPrimitives } from '../directory-node.js';
import {
	createDirectoryStorage,
	sweepStaleScratch,
} from '../directory-store.js';

/**
 * `directory` with its links resolved, or why it cannot hold a folder: it is
 * not a directory. What `.git` is, if anything, does not matter.
 */
export async function localRoot(
	directory: string,
): Promise<Result<string, { root: string; cause: unknown }>> {
	try {
		const resolved = await realpath(directory);
		if (!(await lstat(resolved)).isDirectory())
			throw new Error(`${directory} is not a directory`);
		return Ok(resolved);
	} catch (cause) {
		return Err({ root: directory, cause });
	}
}

/**
 * `.epicenter/scratch` inside the directory at `resolved`, written with `/`
 * as the directory storage writes its own paths, so its parent is the
 * directory's `.epicenter`.
 */
export const scratchDirectory = (resolved: string) =>
	`${resolved}/${STATE_DIRECTORY}/scratch`;

/**
 * The storage of the directory at `resolved` over `node:fs`, after removing
 * what a stopped save left in its scratch directory an hour or more ago.
 */
export async function openNativeStorage(resolved: string) {
	const scratch = scratchDirectory(resolved);
	await sweepStaleScratch(scratch, nodeDirectoryPrimitives);
	return createDirectoryStorage({
		root: resolved,
		scratch,
		primitives: nodeDirectoryPrimitives,
	});
}
