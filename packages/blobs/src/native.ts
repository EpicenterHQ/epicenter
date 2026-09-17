/** Canonical app-local bytes. No account, library, filesystem path, or credential. */
export type BlobDestination = { appId: string };

export function blobDestination(appId: string): BlobDestination {
	return { appId };
}
