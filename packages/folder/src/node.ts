/**
 * `@epicenter/folder/node`: a directory on this computer as a place, for
 * scripts and tests, in Bun or Node (`device/node-store.ts`), its store
 * (`nodeStore`, which `epicenter sync` syncs), and the checks `epicenter
 * check` and `epicenter format` run.
 *
 * The directory holds the contract's files at the contract's paths, the
 * same layout a desktop folder and the browser's private storage hold.
 *
 * @example
 * ```ts
 * import { openFolder } from '@epicenter/folder';
 * import { directory } from '@epicenter/folder/node';
 *
 * const folder = openFolder(recorder, directory('/Users/me/Recordings'));
 * await folder.recordings.set({ id: timeId() }, { title: 'Standup' });
 * ```
 */
import { mkdir, stat } from 'node:fs/promises';
import { Ok } from 'wellcrafted/result';
import { checkStore, formatStore } from './device/folder-tools.js';
import { nodeStore } from './device/node-store.js';
import { OpenFolderError } from './errors.js';
import { type Place, place } from './place.js';

/**
 * The Epicenter folder on this computer (`epicenterRoot`), a folder at a
 * path (`localFolder`, which refuses one inside `.git` or `.epicenter`), a
 * directory's identity, which a record names (`folderIdentity`), and the
 * sweep of stale saves (`sweepSaves`).
 */
export {
	epicenterRoot,
	folderIdentity,
	keptByGit,
	localFolder,
	type StatIdentity,
	sweepSaves,
	tidyLegacy,
} from './device/node-root.js';
/** The store of a directory on this computer: what `epicenter sync` syncs. */
export { nodeStore } from './device/node-store.js';

/**
 * The directory at `path`, made with its missing parents when a folder
 * opens at it: `Unreadable` when it cannot be made or is not a directory.
 */
export function directory(path: string): Place {
	return place(() => ({
		async open() {
			try {
				await mkdir(path, { recursive: true });
				if (!(await stat(path)).isDirectory())
					return OpenFolderError.Unreadable({
						folder: path,
						cause: 'it is not a directory',
					});
			} catch (cause) {
				return OpenFolderError.Unreadable({ folder: path, cause });
			}
			return Ok(nodeStore(path));
		},
	}));
}

/**
 * Every file of the existing directory at `path` checked against `contract`, a
 * contract as code or parsed JSON: `{ files, issues }`, with one issue per
 * problem in path order. A contract that is not well formed is the error.
 */
export function checkFiles(contract: unknown, { path }: { path: string }) {
	return checkStore(contract, nodeStore(path));
}

/**
 * Rewrite every note `contract` claims in the directory at `path` in house
 * style: `{ formatted, unchanged, refused }`.
 */
export function formatNotes(contract: unknown, { path }: { path: string }) {
	return formatStore(contract, nodeStore(path));
}
