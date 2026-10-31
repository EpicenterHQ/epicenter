/**
 * Facts about audio files, read from their names. A file's extension decides
 * the MIME type the app plays or sends it as; how long one plays is read
 * from its bytes by `audioDurationMs` from `@epicenter/recorder`.
 */

const BY_EXTENSION = new Map([
	['wav', 'audio/wav'],
	['webm', 'audio/webm'],
	['m4a', 'audio/mp4'],
	['mp4', 'audio/mp4'],
	['ogg', 'audio/ogg'],
	['oga', 'audio/ogg'],
	['opus', 'audio/ogg'],
	['mp3', 'audio/mpeg'],
	['flac', 'audio/flac'],
	['aac', 'audio/aac'],
]);

export function extensionOf(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The playback MIME type for an audio file, by its extension. */
export function audioMimeTypeOf(path: string): string | undefined {
	return BY_EXTENSION.get(extensionOf(path));
}
