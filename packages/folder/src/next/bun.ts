/**
 * `@epicenter/folder/next/bun`: open an ordinary directory as a folder, in
 * Bun. Each save takes the directory's save lock, the one the desktop shell
 * and other Bun processes take (ADR-0562), and a recursive watch hints at
 * outside changes.
 */
import { sweepStaleScratch } from '../directory-store.js';
import { OpenFolderError } from '../errors.js';
import { localRoot, scratchDirectory } from '../native/directory.js';
import { invalidTable } from '../native/engine.js';
import { nativeStorage, savingPrimitives } from '../native/storage.js';
import { watchDirectory } from '../native/watch.js';
import { createFolder, type Tables } from './folder.js';
import type { Opened, OpenOptions } from './open.js';
import { storageHost } from './storage.js';

export * from './index.js';

export async function openFolder<const T extends Tables>({
	directory,
	...options
}: OpenOptions<T> & { readonly directory: string }): Opened<T> {
	const table = invalidTable(options.tables);
	if (table !== undefined) return OpenFolderError.InvalidTable({ table });
	const { data: root, error } = await localRoot(directory);
	if (error !== null) return OpenFolderError.InvalidRoot(error);
	// What a stopped write staged an hour or more ago goes before opening.
	await sweepStaleScratch(scratchDirectory(root), savingPrimitives(root));
	return createFolder(
		storageHost(nativeStorage(root), { watch: watchDirectory(root) }),
		options,
	);
}
