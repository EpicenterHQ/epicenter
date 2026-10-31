/**
 * Facts about audio files, read from their names and bytes.
 *
 * A file's extension decides the MIME type the app plays or uploads it as, and
 * a WAV's own header gives its play length.
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

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
	String.fromCharCode(...bytes.subarray(offset, offset + length));

export function extensionOf(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The playback MIME type for an audio file, by its extension. */
export function audioMimeTypeOf(path: string): string | undefined {
	return BY_EXTENSION.get(extensionOf(path));
}

const isWav = (bytes: Uint8Array) =>
	bytes.length >= 12 &&
	ascii(bytes, 0, 4) === 'RIFF' &&
	ascii(bytes, 8, 4) === 'WAVE';

/** The play length of PCM WAV bytes, or undefined when they are not readable WAV. */
export function wavDurationMs(bytes: Uint8Array): number | undefined {
	if (!isWav(bytes)) return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let byteRate: number | undefined;
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const id = ascii(bytes, offset, 4);
		const size = view.getUint32(offset + 4, true);
		if (id === 'fmt ' && offset + 20 <= bytes.length)
			byteRate = view.getUint32(offset + 16, true);
		if (id === 'data') {
			if (byteRate === undefined || byteRate === 0) return undefined;
			const length = Math.min(size, bytes.length - offset - 8);
			return Math.round((length / byteRate) * 1000);
		}
		offset += 8 + size + (size % 2);
	}
	return undefined;
}
