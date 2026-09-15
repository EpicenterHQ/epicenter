import type { BlobId } from './blob-id.js';
import { parseBlobId } from './blob-id.js';

const attachmentKey = /^attachment\.([a-zA-Z0-9_-]{1,100})\.([a-z0-9]{24})$/;

/** Internal byte-adapter key: a reversible table/row address within a library. */
export function attachmentStorageId(tableName: string, rowId: string): BlobId {
	const key = `attachment.${tableName}.${rowId}`;
	if (!attachmentKey.test(key))
		throw new TypeError('Invalid attachment address.');
	return key as BlobId;
}

/** Local storage accepts legacy objects and row-addressed attachments. */
export function parseBlobStorageId(value: unknown): BlobId | undefined {
	if (typeof value === 'string' && attachmentKey.test(value))
		return value as BlobId;
	return parseBlobId(value);
}
