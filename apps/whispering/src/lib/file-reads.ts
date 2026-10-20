/** Decoded file values and their cache policies, defined once for every consumer. */
import { openedFile } from '@epicenter/folder/file-browser';
import { defineFileRead } from '@epicenter/svelte/folder-queries';
import { loadAudio, type LoadedAudio } from './audio-source.js';
import { readBytes } from './files.js';

/**
 * A file as Source and Files open it, with its exact bytes: the source a
 * whole-text edit names, carrying the read that answered them.
 */
export const textRead = defineFileRead('text', async (files, path) => {
	const { data: bytes, error } = await readBytes({ files }, path);
	if (error !== null) throw new Error(error);
	return { ...openedFile(bytes), bytes };
});

export const audioRead = defineFileRead(
	'audio',
	async (files, path, { queryKey, client }) => {
		const result = await loadAudio(
			files,
			path,
			client.getQueryData<LoadedAudio>(queryKey),
		);
		if (result.error !== null) throw new Error(result.error.message);
		return result.data;
	},
	{ gcTime: 0, structuralSharing: false },
);
