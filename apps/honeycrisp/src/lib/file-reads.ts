/** The exact source a whole-file editor reads and uses as its save base. */
import { fileBytes } from '@epicenter/folder';
import { openedFile, type OpenedFile } from '@epicenter/folder/file-browser';
import { defineFileRead } from '@epicenter/svelte/folder-queries';

/** A file as the text view opens it, with the exact bytes an edit starts from. */
export type FileRead =
	| { readonly kind: 'missing' }
	| ({ readonly bytes: Uint8Array } & OpenedFile);

/** Exact source bytes stay beside decoded text as the base for whole-file saves. */
export const textRead = defineFileRead(
	'text',
	async (files, path): Promise<FileRead> => {
		const read = await files.read(path);
		if (read.error !== null) throw read.error;
		if (read.data === undefined) return { kind: 'missing' };
		// The bytes keep the read they came from, so own saves show over them.
		const bytes = await fileBytes(read.data.content);
		return { bytes, ...openedFile(bytes) };
	},
);
