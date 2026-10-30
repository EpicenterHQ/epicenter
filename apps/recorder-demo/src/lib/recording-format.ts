/**
 * What to ask `MediaRecorder` for, and what to name what it gives (decision
 * 56). AAC in MP4 first, because the file lands in a folder that native
 * players open; Opus in WebM second. Never bare `audio/mp4`, whose codec
 * differs by engine.
 */
export const RECORDING_TYPES = [
	'audio/mp4;codecs=mp4a.40.2',
	'audio/webm;codecs=opus',
] as const;

/** The first of {@link RECORDING_TYPES} the browser can record, or undefined to take its default. */
export function chooseRecordingType(
	isTypeSupported: (type: string) => boolean,
): string | undefined {
	return RECORDING_TYPES.find((type) => isTypeSupported(type));
}

const EXTENSIONS: Record<string, string> = {
	'audio/mp4': 'm4a',
	'audio/webm': 'webm',
	'audio/ogg': 'ogg',
};

/**
 * The extension for the type a recording actually has, read from the
 * produced audio rather than the request: engines differ in what they
 * honor, and in spacing (`audio/mp4; codecs=mp4a.40.2`). Null for a type
 * this app does not name.
 */
export function extensionOf(type: string): string | null {
	const base = type.split(';')[0]?.trim().toLowerCase() ?? '';
	return EXTENSIONS[base] ?? null;
}
