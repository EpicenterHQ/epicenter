/** What a file is, as the text view opens it: text, binary, or too large, with its size. */
import { openedFile, type OpenedFile } from '@epicenter/folder/file-browser';
import { defineFileRead } from '@epicenter/svelte/folder-queries';

/** A file as the text view opens it. The folder's edit of it holds its exact text. */
export type FileRead =
	| { readonly kind: 'missing' }
	| { readonly kind: 'text' }
	| Exclude<OpenedFile, { kind: 'text' }>;

/** What the file at a path is; the text itself is the folder's edit of it. */
export const textRead = defineFileRead(
	'text',
	async (files, path): Promise<FileRead> => {
		const read = await files.read(path);
		if (read.error !== null) throw read.error;
		if (read.data === undefined) return { kind: 'missing' };
		const opened = openedFile(
			new Uint8Array(await read.data.content.arrayBuffer()),
		);
		return opened.kind === 'text' ? { kind: 'text' } : opened;
	},
);
