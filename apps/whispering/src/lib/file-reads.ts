/** Decoded file values and their cache policies, defined once for every consumer. */
import { openedFile } from '@epicenter/folder/file-browser';
import { defineFileRead } from '@epicenter/svelte/folder-queries';
import { audioMimeTypeOf } from './audio-format.js';
import { readBytes } from './files.js';

type LoadedAudio = {
	readonly path: string;
	readonly sha256: string;
	readonly blob: Blob;
};

/**
 * What a file is as Source and Files open it: text, binary, or too large,
 * with its size. Its text is the folder's edit of the file, which this read
 * keeps current while the edit holds it.
 */
export const textRead = defineFileRead('text', async (files, path) => {
	const { data: bytes, error } = await readBytes({ files }, path);
	if (error !== null) throw new Error(error);
	const opened = openedFile(bytes);
	return opened.kind === 'text' ? ({ kind: 'text' } as const) : opened;
});

/** Hash exact bytes so a refresh preserves playback unless the audio changed. */
export const audioRead = defineFileRead(
	'audio',
	async (files, path, { queryKey, client }) => {
		const current = client.getQueryData<LoadedAudio>(queryKey);
		const { data: bytes, error } = await readBytes({ files }, path);
		if (error !== null) throw new Error(error);
		const digest = await crypto.subtle.digest(
			'SHA-256',
			bytes as Uint8Array<ArrayBuffer>,
		);
		const sha256 = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, '0'),
		).join('');
		if (current?.path === path && current.sha256 === sha256) return current;
		return {
			path,
			sha256,
			blob: new Blob([bytes as Uint8Array<ArrayBuffer>], {
				type: audioMimeTypeOf(path) ?? '',
			}),
		};
	},
	{ gcTime: 0, structuralSharing: false },
);
