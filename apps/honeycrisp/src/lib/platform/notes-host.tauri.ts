/**
 * The desktop leaf: the notes are a real directory the desktop shell grants.
 *
 * `openFolder` from `@epicenter/folder/tauri` asks the shell for the folder
 * by its ID and runs the folder engine over the directory it grants. The page
 * names the ID and nothing else: the root and the fallback commit author are
 * the shell's, and the author and any `origin` come from Git's configuration.
 *
 * The terminal is the shell's own `/bin/sh`, an outside writer, not the
 * folder's emulated one.
 *
 * A folder that cannot be opened is an error on screen. There is no other
 * store to fall back to: this entry refuses outside the desktop app.
 */
import { openFolder } from '@epicenter/folder/tauri';
import { honeycrispDefinition } from '../data.js';
import { setUpFolder } from './first-open.js';
import { openShellServices } from './shell.tauri.js';
import {
	HONEYCRISP_FOLDER_ID,
	type NotesHost,
	type OpenNotes,
} from './types.js';

async function acquire(): Promise<NotesHost> {
	const { data: folder, error } = await openFolder({
		id: HONEYCRISP_FOLDER_ID,
		definition: honeycrispDefinition,
	});
	if (error) throw new Error(error.message);
	try {
		// The shell holds the directory's lock now. An existing folder is left
		// as it is.
		await setUpFolder(folder.files, Object.keys(honeycrispDefinition.tables));
		return {
			folder,
			...(await openShellServices()),
			close: () => folder.close(),
		};
	} catch (cause) {
		await folder.close();
		throw cause;
	}
}

// Closing the window quits at once: every save is already in its file.
export const openNotes: OpenNotes = async ({ create }) => {
	const host = await acquire();
	try {
		return await create(host);
	} catch (cause) {
		await host.close();
		throw cause;
	}
};
