/**
 * `@epicenter/folder` in a desktop build (the `tauri` leaf): `openFolder`
 * opens the app's data folder, the `Data` root the shell named at startup
 * from the app's bundle identifier (ADR-0752), and brings its root
 * `AGENTS.md` up to date with the site's contract. The page never holds the
 * folder's path except to show it (`folder.displayPath()`, once it
 * opened). An `account` changes nothing here: Epicenter syncs the folder.
 */
import type { Contract } from '@epicenter/definition/contract';
import { openDataFolder } from './desktop-folder.js';
import { createFolder, type Folder, type OpenFolder } from './folder.js';
import { openOf, pathOf, recordOpen } from './native/opens.js';
import { openDevice, revealRoot } from './tauri.js';

export { OpenFolderError } from './errors.js';
export type {
	Folder,
	FolderAccount,
	FolderCollection,
	FolderFiles,
	FolderNotes,
	FolderState,
	OpenFolderOptions,
} from './folder.js';

/**
 * The app's data folder, opening at once. With `{ site }`, its `AGENTS.md`
 * links the contract the site publishes. A contract that is not well formed
 * throws.
 */
export const openFolder: OpenFolder = <TContract extends Contract>(
	contract: TContract,
	options?: { site: string },
) => {
	const folder: Folder<TContract> = createFolder(
		contract,
		async () => {
			const opened =
				options === undefined
					? await openDevice(contract, { root: 'Data' })
					: await openDataFolder(contract, options.site);
			if (opened.error === null) recordOpen(folder, openOf(opened.data));
			return opened;
		},
		{ reveal: () => revealRoot('Data'), displayPath: () => pathOf(folder) },
	);
	return folder;
};
