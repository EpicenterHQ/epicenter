/**
 * The browser leaf: a folder in this browser's OPFS, with the same
 * files and Git history as the desktop directory. Nothing native is imported
 * here, and this entry refuses inside the desktop app.
 *
 * A tab's leave guards are the page's own, in `NotesView`.
 */
import { openFolder } from '@epicenter/folder/browser';
import { honeycrispDefinition } from '../data.js';
import { HONEYCRISP_FOLDER_ID, type OpenNotesFolder } from './types.js';

/** Called from the mounted page; importing this module opens nothing. */
export const openNotesFolder: OpenNotesFolder = async () => {
	const { data: folder, error } = await openFolder({
		id: HONEYCRISP_FOLDER_ID,
		definition: honeycrispDefinition,
		browser: { author: { name: 'Honeycrisp', email: 'honeycrisp@localhost' } },
	});
	if (error) throw new Error(error.message);
	return folder;
};
