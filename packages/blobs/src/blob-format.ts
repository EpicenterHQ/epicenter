/** Format interpretation for producers, saved keys, uploads, and filenames. */
const FORMATS = [
	{
		extension: 'wav',
		contentType: 'audio/wav',
		family: 'wav',
		types: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
	},
	{
		extension: 'mp3',
		contentType: 'audio/mpeg',
		family: 'mp3',
		types: ['audio/mpeg', 'audio/mp3', 'audio/x-mp3'],
	},
	{
		extension: 'm4a',
		contentType: 'audio/mp4',
		family: 'mp4',
		types: ['audio/mp4', 'audio/m4a', 'audio/x-m4a'],
	},
	{
		extension: 'mp4',
		contentType: 'video/mp4',
		family: 'mp4',
		types: ['video/mp4', 'application/mp4'],
	},
	{
		extension: 'webm',
		contentType: 'video/webm',
		family: 'webm',
		types: ['audio/webm', 'video/webm'],
	},
	{
		extension: 'ogg',
		contentType: 'audio/ogg',
		family: 'ogg',
		types: ['audio/ogg', 'video/ogg', 'application/ogg'],
	},
	{
		extension: 'opus',
		contentType: 'audio/ogg',
		family: 'ogg',
		types: ['audio/opus'],
	},
	{
		extension: 'flac',
		contentType: 'audio/flac',
		family: 'flac',
		types: ['audio/flac', 'audio/x-flac'],
	},
	{
		extension: 'aac',
		contentType: 'audio/aac',
		family: 'aac',
		types: ['audio/aac', 'audio/x-aac'],
	},
	{
		extension: 'aiff',
		contentType: 'audio/aiff',
		family: 'aiff',
		types: ['audio/aiff', 'audio/x-aiff'],
	},
	{
		extension: 'wma',
		contentType: 'audio/x-ms-wma',
		family: 'wma',
		types: ['audio/x-ms-wma'],
	},
	{
		extension: 'mov',
		contentType: 'video/quicktime',
		family: 'mov',
		types: ['video/quicktime'],
	},
	{
		extension: 'avi',
		contentType: 'video/x-msvideo',
		family: 'avi',
		types: ['video/x-msvideo', 'video/avi'],
	},
	{
		extension: 'wmv',
		contentType: 'video/x-ms-wmv',
		family: 'wmv',
		types: ['video/x-ms-wmv'],
	},
	{
		extension: 'flv',
		contentType: 'video/x-flv',
		family: 'flv',
		types: ['video/x-flv'],
	},
	{
		extension: 'mkv',
		contentType: 'video/x-matroska',
		family: 'mkv',
		types: ['video/x-matroska', 'audio/x-matroska'],
	},
	{
		extension: 'm4v',
		contentType: 'video/mp4',
		family: 'mp4',
		types: ['video/x-m4v'],
	},
	{
		extension: 'mpeg',
		contentType: 'video/mpeg',
		family: 'mpeg',
		types: ['video/mpeg'],
	},
	{
		extension: 'png',
		contentType: 'image/png',
		family: 'png',
		types: ['image/png'],
	},
	{
		extension: 'jpg',
		contentType: 'image/jpeg',
		family: 'jpg',
		types: ['image/jpeg'],
	},
	{
		extension: 'gif',
		contentType: 'image/gif',
		family: 'gif',
		types: ['image/gif'],
	},
	{
		extension: 'webp',
		contentType: 'image/webp',
		family: 'webp',
		types: ['image/webp'],
	},
	{
		extension: 'svg',
		contentType: 'image/svg+xml',
		family: 'svg',
		types: ['image/svg+xml'],
	},
	{
		extension: 'pdf',
		contentType: 'application/pdf',
		family: 'pdf',
		types: ['application/pdf'],
	},
	{
		extension: 'json',
		contentType: 'application/json;charset=utf-8',
		family: 'json',
		types: ['application/json'],
	},
	{
		extension: 'zip',
		contentType: 'application/zip',
		family: 'zip',
		types: ['application/zip', 'application/x-zip-compressed'],
	},
	{
		extension: 'txt',
		contentType: 'text/plain;charset=utf-8',
		family: 'txt',
		types: ['text/plain'],
	},
] as const;

const EXTENSION_ALIASES: Record<string, string> = {
	weba: 'webm',
	oga: 'ogg',
	ogv: 'ogg',
	wave: 'wav',
	aif: 'aiff',
	jpeg: 'jpg',
	mpg: 'mpeg',
};
const UNKNOWN = { extension: 'bin', contentType: 'application/octet-stream' };

function mediaType(value: string) {
	return value.split(';', 1)[0]!.trim().toLowerCase();
}

function byType(value: string) {
	const normalized = mediaType(value);
	return FORMATS.find((format) =>
		format.types.some((type) => type === normalized),
	);
}

function byExtension(extension: string) {
	const normalized = EXTENSION_ALIASES[extension] ?? extension;
	return FORMATS.find((format) => format.extension === normalized);
}

/**
 * Prefer the producer's known media type. Only absent/generic types may use a
 * File's filename; an unknown explicit type stays binary. No bytes are converted.
 * Structural filename access preserves File evidence across realms and on Bun.
 */
export function selectBlobFormat(input: { type: string; name?: string }): {
	extension: string;
	contentType: string;
} {
	const known = byType(input.type);
	if (known)
		return { extension: known.extension, contentType: known.contentType };
	const type = mediaType(input.type);
	if (
		type &&
		type !== 'application/octet-stream' &&
		type !== 'binary/octet-stream'
	)
		return { ...UNKNOWN };
	const extension = input.name?.split('.').at(-1)?.toLowerCase();
	const named =
		extension && input.name?.includes('.') ? byExtension(extension) : undefined;
	return named
		? { extension: named.extension, contentType: named.contentType }
		: { ...UNKNOWN };
}

/** Conventional type for a complete key already validated at its boundary. */
export function blobKeyFormat(id: string): {
	extension: string;
	contentType: string;
} {
	const extension = id.slice(id.lastIndexOf('.') + 1);
	const format = byExtension(extension);
	return { extension, contentType: format?.contentType ?? UNKNOWN.contentType };
}

/** Refuse a declared known format that conflicts with the immutable key. */
export function assertBlobFormat(id: string, input: { type: string }): void {
	const declared = byType(input.type);
	if (!declared) return;
	const saved = byExtension(blobKeyFormat(id).extension);
	if (declared.family !== saved?.family) {
		throw new TypeError(
			`Blob type '${input.type}' conflicts with key '${id}'.`,
		);
	}
}

/** Preserve declared MIME parameters; infer only absent/generic producer types. */
export function blobInputContentType(input: {
	type: string;
	name?: string;
}): string {
	const type = mediaType(input.type);
	return !type ||
		type === 'application/octet-stream' ||
		type === 'binary/octet-stream'
		? selectBlobFormat(input).contentType
		: input.type;
}
