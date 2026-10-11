/**
 * The browser leaf: a folder in this browser's OPFS, with the same
 * files and Git history as the desktop directory, and the folder's own shell
 * emulated over those files. Nothing native is imported here, and this entry
 * refuses inside the desktop app.
 *
 * A tab has no host close signal: `pagehide` starts the page's flush, and the
 * page's leave prompt is the browser's.
 */

import { openFolder } from '@epicenter/folder/browser';
import type { HostCloseSignal } from '@epicenter/svelte/flush-on-close';
import { honeycrispDefinition } from '../data.js';
import {
	HONEYCRISP_FOLDER_ID,
	type NotesHost,
	type OpenHost,
} from './types.js';

export const hostClose: HostCloseSignal | undefined = undefined;

export const openHost: OpenHost = async (): Promise<NotesHost> => {
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
				'The same files as the app · git status, diff, log; saves request history',
			exec: (command) => terminal.exec(command),
		},
		location: 'This browser',
		reveal: undefined,
		history: undefined,
		close: () => folder.close(),
	};
};
