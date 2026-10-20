/**
 * The native `Folder` over a directory this Bun process names:
 * `openBunFolder({ directory, tables })`.
 *
 * `directory` is a trusted path to an existing directory; opening creates
 * nothing in it and changes no file a person left there. Git is optional:
 * the directory need not have `.git`, and a `.git` file or link is left as
 * it is. This process reaches the disk itself (`directory-node.ts`): a new
 * file's bytes are staged in `.<name>.epicenter-scratch` beside the
 * directory, which only this account can read on Unix (`0700`, each staged
 * file `0600`), and renamed over the path, keeping the mode of a file it
 * replaces. Each rename or removal, with the check of the bytes it expects
 * there, holds the directory's save lock, the one the desktop shell and
 * other Bun processes take (ADR-0562). A save
 * waits up to ten seconds for another process's; past that it fails and
 * changes nothing (`directory.ts` here).
 *
 * Nothing watches the directory, so `onChange` reports this handle's saves
 * and those of other handles of the directory in this process, not other
 * programs' edits.
 */
import type { TSchema as Schema } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { nodeDirectoryPrimitives } from '../directory-node.js';
import type { DirectoryPrimitives } from '../directory-primitives.js';
import {
	createDirectoryStorage,
	sweepStaleScratch,
} from '../directory-store.js';
import { OpenFolderError } from '../errors.js';
import type { DirectoryFolderOptions, Folder } from '../folder.js';
import { holdingSaveLock, localRoot, scratchDirectory } from './directory.js';
import { createNativeFolder, invalidTable } from './engine.js';

/**
 * Open the directory at `directory`, an existing directory whose links are
 * resolved once, at open. Refusals are returned, not thrown: a
 * table name that cannot be one top-level directory (`InvalidTable`), or a
 * path that is not a directory, or is the file system's root, with no
 * parent to keep the save lock in (`InvalidRoot`).
 */
export async function openBunFolder<
	const TTables extends Record<string, Schema>,
>({
	directory,
	tables,
}: DirectoryFolderOptions<TTables>): Promise<
	Result<Folder<TTables>, OpenFolderError>
> {
	const table = invalidTable(tables);
	if (table !== undefined) return OpenFolderError.InvalidTable({ table });
	if (typeof directory !== 'string' || directory === '')
		return OpenFolderError.InvalidRoot({
			root: String(directory),
			cause: new Error('no directory was named'),
		});
	const { data: resolved, error } = await localRoot(directory);
	if (error !== null) return OpenFolderError.InvalidRoot(error);
	const scratch = scratchDirectory(resolved);
	const primitives = savingPrimitives(resolved);
	// What a stopped write staged an hour or more ago goes before opening.
	await sweepStaleScratch(scratch, primitives);
	return Ok(
		createNativeFolder({
			storage: createDirectoryStorage({
				root: resolved,
				primitives,
				scratch,
			}),
			tables,
			directory: `bun:${resolved}`,
		}),
	);
}

/**
 * `node:fs`, with each rename and removal, and the check of what it expects
 * just before it, under the directory's save lock, as the desktop shell
 * makes each one under its publishing and save locks.
 */
function savingPrimitives(resolved: string): DirectoryPrimitives {
	return {
		...nodeDirectoryPrimitives,
		rename: (from, to, expected) =>
			holdingSaveLock(resolved, () =>
				nodeDirectoryPrimitives.rename(from, to, expected),
			),
		remove: (path, options) =>
			holdingSaveLock(resolved, () =>
				nodeDirectoryPrimitives.remove(path, options),
			),
	};
}
