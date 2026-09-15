import type { AttachmentContent } from './blob-store.js';

/** Compare verified content evidence, never an HTTP status or an ETag. */
export function sameAttachmentContent(
	a: AttachmentContent,
	b: AttachmentContent,
) {
	return (
		a.sha256 === b.sha256 &&
		a.size === b.size &&
		a.contentType === b.contentType
	);
}

export async function attachmentContent(
	blob: Blob,
): Promise<AttachmentContent> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		await blob.arrayBuffer(),
	);
	return {
		sha256: Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, '0'),
		).join(''),
		size: blob.size,
		contentType: blob.type || 'application/octet-stream',
	};
}
