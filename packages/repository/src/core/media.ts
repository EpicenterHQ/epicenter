/**
 * What a file is, from its path alone: its media type by extension, as a
 * device answers a blob's bytes and a server serves them. The store never
 * records a type; the path is the one place it lives.
 */

const BY_EXTENSION: ReadonlyMap<string, string> = new Map([
	// Audio (Whispering's table)
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
	// Video
	['mov', 'video/quicktime'],
	['mkv', 'video/x-matroska'],
	['ogv', 'video/ogg'],
	// Images
	['png', 'image/png'],
	['jpg', 'image/jpeg'],
	['jpeg', 'image/jpeg'],
	['gif', 'image/gif'],
	['webp', 'image/webp'],
	['avif', 'image/avif'],
	['heic', 'image/heic'],
	['svg', 'image/svg+xml'],
	['ico', 'image/x-icon'],
	// Documents and data
	['pdf', 'application/pdf'],
	['txt', 'text/plain'],
	['csv', 'text/csv'],
	['json', 'application/json'],
	['zip', 'application/zip'],
	['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
	['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
	['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]);

/** A path's extension, lower case, without its dot; empty when its name has none. */
export function extensionOf(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** A path's media type by its extension; `application/octet-stream` when unknown. */
export const mediaType = (path: string) => BY_EXTENSION.get(extensionOf(path)) ?? 'application/octet-stream';
