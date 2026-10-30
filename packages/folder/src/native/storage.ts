/** Native Bun storage for folder saves, history, and declaration patches. */
import { nodeDirectoryPrimitives } from '../directory-node.js';
import type { DirectoryPrimitives } from '../directory-primitives.js';
import { createDirectoryStorage } from '../directory-store.js';
import { holdingSaveLock, scratchDirectory } from './directory.js';

/** Storage at a resolved root; each publication uses the shared save lock. */
export function nativeStorage(root: string) {
	return createDirectoryStorage({
		root,
		scratch: scratchDirectory(root),
		primitives: savingPrimitives(root),
		hold: {
			lock: <T>(work: () => Promise<T>) => holdingSaveLock(root, work),
			held: nodeDirectoryPrimitives,
		},
	});
}

/** The same publication lock also protects deletion of abandoned scratch files. */
export function savingPrimitives(root: string): DirectoryPrimitives {
	return {
		...nodeDirectoryPrimitives,
		rename: (from, to, expected) =>
			holdingSaveLock(root, () =>
				nodeDirectoryPrimitives.rename(from, to, expected),
			),
		remove: (path, options) =>
			holdingSaveLock(root, () =>
				nodeDirectoryPrimitives.remove(path, options),
			),
	};
}
