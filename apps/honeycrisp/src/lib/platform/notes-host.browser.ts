/**
 * The browser leaf: a folder in this browser's OPFS, with the same
 * files and Git history as the desktop directory. A browser has no shell, so
 * there is no terminal. Nothing native is imported here, and this entry
 * refuses inside the desktop app.
 */
import { openFolder } from '@epicenter/folder/browser';
import { honeycrispDefinition } from '../data.js';
import {
	HONEYCRISP_FOLDER_ID,
	type NotesHost,
	type OpenNotes,
} from './types.js';

async function acquire(): Promise<NotesHost> {
	const { data: folder, error } = await openFolder({
		id: HONEYCRISP_FOLDER_ID,
		definition: honeycrispDefinition,
		browser: { author: { name: 'Honeycrisp', email: 'honeycrisp@localhost' } },
	});
	if (error) throw new Error(error.message);
	return {
		folder,
		terminal: undefined,
		location: 'This browser',
		reveal: undefined,
		history: undefined,
		close: () => folder.close(),
	};
}

// A tab's leave guards are the page's own, in `NotesView`.
export const openNotes: OpenNotes = async ({ create }) => {
	const host = await acquire();
	try {
		return await create(host);
	} catch (cause) {
		await host.close();
		throw cause;
	}
};
