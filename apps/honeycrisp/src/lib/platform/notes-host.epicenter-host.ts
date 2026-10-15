/**
 * The Epicenter host leaf: Honeycrisp is an installed app (ADR-0552), so the
 * notes are a real directory the Epicenter shell grants this window, and the
 * page runs the folder engine over it (ADR-0531).
 *
 * The shell opens the window with the folder it hands it as `?folder=<scope>`
 * (`open_installed_app`): Honeycrisp's own folder, `HONEYCRISP_FOLDER_ID`, or
 * another folder whose declaration contains Honeycrisp's shape (ADR-0538). A
 * window handed no folder opens Honeycrisp's own.
 *
 * Honeycrisp owns its own folder's schema, so it opens that folder with
 * `openFolder`, which publishes `honeycrispDefinition`, and sets up what its
 * layout is missing (`first-open.ts`). Any other folder opens with
 * `openDataFolder` and `honeycrispDefinition` as the lens: its declaration is
 * never written, nothing is set up in it, and one that does not contain the
 * lens is refused, named.
 *
 * The page names the folder by its scope and nothing else; the shell chose
 * the directory, the fallback author, and the windows that may use it. The
 * author and any `origin` come from Git's configuration. Epicenter gives an
 * installed window no terminal, reveal, or per-file history command, so
 * those stay absent here, as in the browser.
 *
 * A folder that cannot be opened is an error on screen. There is no browser
 * folder to fall back to in this build. Quitting Epicenter asks this window
 * nothing (ADR-0542).
 */
import { openDataFolder, openFolder } from '@epicenter/folder/tauri';
import { honeycrispDefinition } from '../data.js';
import { setUpFolder } from './first-open.js';
import {
	HONEYCRISP_FOLDER_ID,
	type NotesFolder,
	type NotesHost,
	type OpenNotes,
} from './types.js';

/** The scope the shell handed this window as `?folder=`, if any. */
function handedFolder(): string | undefined {
	const handed = new URLSearchParams(globalThis.location?.search).get('folder');
	return handed || undefined;
}

/**
 * The folder's name as a person knows it, its directory's: the shell scopes
 * a listed folder `data:<directory>`, and an app's own folder by its
 * directory, the app's id (`apps/epicenter/src-tauri/src/data_folders.rs`).
 */
function folderName(id: string): string {
	return id.startsWith('data:') ? id.slice('data:'.length) : id;
}

async function openHandedFolder(id: string): Promise<NotesFolder> {
	if (id === HONEYCRISP_FOLDER_ID) {
		const { data: folder, error } = await openFolder({
			id,
			definition: honeycrispDefinition,
		});
		if (error) throw new Error(error.message, { cause: error });
		try {
			// The shell holds the directory's lock now. An existing folder is
			// left as it is.
			await setUpFolder(folder.files, Object.keys(honeycrispDefinition.tables));
		} catch (cause) {
			await folder.close();
			throw cause;
		}
		return folder;
	}
	const { data: folder, error } = await openDataFolder({
		id,
		lens: honeycrispDefinition,
	});
	if (error?.name === 'ShapeMismatch')
		throw new Error(
			`Honeycrisp cannot open the folder '${folderName(id)}': ${error.problems.map((problem) => problem.message).join('; ')}.`,
			{ cause: error },
		);
	if (error) throw new Error(error.message, { cause: error });
	return folder;
}

async function acquire(): Promise<NotesHost> {
	const folder = await openHandedFolder(handedFolder() ?? HONEYCRISP_FOLDER_ID);
	const { location } = folder;
	return {
		folder,
		terminal: undefined,
		location:
			location.kind === 'directory' ? location.root : location.directory,
		reveal: undefined,
		history: undefined,
		close: () => folder.close(),
	};
}

// Called from the mounted page; importing this module opens nothing.
export const openNotes: OpenNotes = async ({ create }) => {
	const host = await acquire();
	try {
		return await create(host);
	} catch (cause) {
		await host.close();
		throw cause;
	}
};
