/**
 * A native Bun folder: a directory whose saves stage in its own
 * `.epicenter/saves` (`savesDirectory`), on the directory's own file system,
 * so the rename over a path is one step. It needs no Git, so a directory
 * without `.git`, or with a `.git` file or link, opens and saves alike, and
 * saving creates nothing beside it and nothing in it but the files saved and
 * `.epicenter`. A link at `.epicenter` is never followed.
 */
import { lstat, realpath } from 'node:fs/promises';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { nodeDirectoryPrimitives } from '../directory-node.js';
import {
	createDirectoryStorage,
	sweepStaleScratch,
} from '../directory-store.js';
import { savesDirectory } from '../state.js';

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
 * The storage of the directory at `resolved` over `node:fs`, after removing
 * what a stopped save left in its `.epicenter/saves` an hour or more ago.
 */
export async function openNativeStorage(resolved: string) {
	const saves = savesDirectory(resolved);
	await sweepStaleScratch(saves, nodeDirectoryPrimitives);
	return createDirectoryStorage({
		root: resolved,
		saves,
		primitives: nodeDirectoryPrimitives,
	});
}
