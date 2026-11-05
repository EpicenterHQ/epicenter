/**
 * `@epicenter/folder` in a desktop build (the `tauri` leaf): `home` is the
 * app's data folder, the `Data` root the shell named at startup from the
 * app's bundle identifier (ADR-0752), and opening it brings its root
 * `AGENTS.md` up to date with the site's contract (ADR-0772). The page
 * never holds the folder's path except to show it (`folder.displayPath()`,
 * once it opened). An `account` changes nothing here: Epicenter syncs the
 * folder.
 */
import { Ok } from 'wellcrafted/result';
import { refreshAgentsNote } from './desktop-folder.js';
import { openRoot } from './native/root.js';
import { type HomeOptions, type Place, place } from './place.js';
import { revealRoot } from './tauri.js';

export { OpenFolderError } from './errors.js';
export type {
	Folder,
	FolderCollection,
	FolderFiles,
	FolderNotes,
	FolderState,
} from './folder.js';
export { openFolder } from './open-folder.js';
export type { Place } from './place.js';

/**
 * The app's data folder, whose `AGENTS.md` links the contract `site`
 * publishes, when there is one. It can be revealed in the file manager even when it did not
 * open, and shows its path once it opened.
 */
export function home(options?: HomeOptions): Place {
	return place((contract) => {
		let path: string | null = null;
		return {
			async open() {
				const opened = await openRoot('Data');
				if (opened.error !== null) return opened;
				path = opened.data.path;
				if (options !== undefined)
					await refreshAgentsNote(
						opened.data.store,
						contract,
						`${options.site}/contract.json`,
					);
				return Ok(opened.data.store);
			},
			reveal: () => revealRoot('Data'),
			displayPath: () => path,
		};
	});
}
