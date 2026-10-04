import {
	defineErrors,
	extractErrorMessage,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { BlobId } from './blob-id.js';
import type { BlobNotFound, BlobStoreFailed } from './blobs.js';

/**
 * @fileoverview The portable playback-source contract.
 *
 * A source turns a {@link BlobId} into a URL a media element (or download)
 * can consume right now, on this platform. It is a sibling capability beside
 * the byte store, not a method on `Blobs`: bytes are portable, URLs are not.
 *
 * Every source is a standard `Disposable`. The contract promises that release
 * is always safe and idempotent, not that every implementation allocates a
 * revocable resource: the browser implementation revokes its object URL
 * exactly once, while a desktop WebView source points at a stable
 * same-origin route and its disposer is a harmless no-op. Callers release
 * unconditionally (`using` in bounded scopes, a manual `[Symbol.dispose]()`
 * in component teardown) and substitution holds across platforms.
 */

export const BlobSourceError = defineErrors({
	/** Acquiring the source itself failed after the store answered. */
	BlobSourceFailed: ({ id, cause }: { id: BlobId; cause: unknown }) => ({
		message: `Could not open a source for blob '${id}': ${extractErrorMessage(cause)}`,
		id,
		cause,
	}),
});
export type BlobSourceError = InferErrors<typeof BlobSourceError>;
export type BlobSourceFailed = InferError<
	typeof BlobSourceError.BlobSourceFailed
>;

/** One acquired, independently releasable URL over local blob bytes. */
export type BlobSource = Disposable & { readonly url: string };

/**
 * Acquire playback sources over one local blob store. Each `open` owns one
 * independent acquisition; the storage layer deliberately has no shared URL
 * cache or reference counts. Store errors surface unmapped (typed errors
 * compose bottom-up), so callers can still branch on missing local bytes.
 */
export type BlobSources = {
	open(
		id: BlobId,
	): Promise<
		Result<BlobSource, BlobNotFound | BlobStoreFailed | BlobSourceFailed>
	>;
};
