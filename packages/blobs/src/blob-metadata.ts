import { parseBlobId } from './blob-id.js';
import type { BlobListOptions, BlobStat } from './blob-store.js';

/** Validate bounded HTTP metadata at the WebView transport boundary. */
export function normalizeContentType(contentType: string): string {
	const normalized = contentType.trim();
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters at the HTTP metadata boundary.
	const hasControls = /[\u0000-\u001f\u007f]/u.test(normalized);
	return normalized === '' || normalized.length > 255 || hasControls
		? 'application/octet-stream'
		: normalized;
}

export function blobListOptions({ cursor, limit = 100 }: BlobListOptions = {}) {
	if (cursor !== undefined && parseBlobId(cursor) === undefined)
		throw new TypeError('Blob cursor must be a BlobId.');
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
		throw new TypeError('Blob page limit must be an integer from 1 to 1000.');
	return { cursor, limit };
}

export function isBlobMetadata(value: unknown): value is BlobStat {
	if (!value || typeof value !== 'object') return false;
	return (
		'size' in value &&
		typeof value.size === 'number' &&
		Number.isSafeInteger(value.size) &&
		value.size >= 0 &&
		'contentType' in value &&
		typeof value.contentType === 'string' &&
		normalizeContentType(value.contentType) === value.contentType
	);
}
