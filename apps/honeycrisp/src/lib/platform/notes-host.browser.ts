/**
 * The browser leaf: a folder in this browser's OPFS, with the same
 * files and Git history as the desktop directory, and the folder's own shell
 * emulated over those files. Nothing native is imported here, and this entry
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
	const terminal = folder.terminal();
	return {
		folder,
		terminal: {
			get cwd() {
				return terminal.cwd;
			},
			description:
				'The same files as the app · git status, diff, log, add, commit',
			exec: (command) => terminal.exec(command),
		},
		location: 'This browser',
		reveal: undefined,
		history: undefined,
		close: () => folder.close(),
	};
}

// A tab has no shell to ask before it closes; the page's leave guards apply.
export const openNotes: OpenNotes = async ({ create }) => {
	const host = await acquire();
	try {
		return await create(host);
	} catch (cause) {
		await host.close();
		throw cause;
	}
};
