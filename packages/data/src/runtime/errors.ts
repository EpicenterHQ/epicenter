import {
	defineErrors,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';

const RecordHandleError = defineErrors({
	RecordNotLive: ({ address }: { address: string }) => ({
		message: `Record '${address}' is not live`,
		address,
	}),
});

const BlobCaptureError = defineErrors({
	BlobAlreadyCaptured: ({ address }: { address: string }) => ({
		message: `Blob slot '${address}' already owns different bytes`,
		address,
	}),
	BlobSourceRead: ({
		address,
		cause,
	}: {
		address: string;
		cause: unknown;
	}) => ({
		message: `Blob source for '${address}' could not be read`,
		address,
		cause,
	}),
});

const RowDocumentError = defineErrors({
	RevokedDocument: ({ address }: { address: string }) => ({
		message: `Row document '${address}' was revoked because its record is no longer live`,
		address,
	}),
});

const DocumentPullError = defineErrors({
	/**
	 * This replica has no authority to read from: it was opened unclaimed or
	 * signed out, or the authority lifetime it holds is not bound yet. Local
	 * editing continues; only remote freshness is unavailable.
	 */
	DocumentPullUnavailable: ({ address }: { address: string }) => ({
		message: `Row document '${address}' has no authority to pull from`,
		address,
	}),
	/**
	 * The pull could not complete or its answer could not be installed. This is
	 * always operational and always retryable: the local document stays open
	 * and usable, and nothing durable records the attempt.
	 */
	DocumentPullFailed: ({
		address,
		cause,
	}: {
		address: string;
		cause: unknown;
	}) => ({
		message: `Row document '${address}' could not be pulled`,
		address,
		cause,
	}),
});

export const RuntimeError = {
	...RecordHandleError,
	...BlobCaptureError,
	...RowDocumentError,
	...DocumentPullError,
};

export type RecordNotLiveError = InferErrors<typeof RecordHandleError>;
export type BlobCaptureError = InferErrors<typeof BlobCaptureError>;
export type BlobAlreadyCapturedError = InferError<
	typeof BlobCaptureError.BlobAlreadyCaptured
>;
export type BlobSourceReadError = InferError<
	typeof BlobCaptureError.BlobSourceRead
>;
export type RevokedDocumentError = InferErrors<typeof RowDocumentError>;
/** Every way one explicit `pull()` can decline, all of them retryable. */
export type DocumentPullError =
	| InferErrors<typeof DocumentPullError>
	| RevokedDocumentError;
export type RuntimeError =
	| RecordNotLiveError
	| BlobCaptureError
	| RevokedDocumentError
	| InferErrors<typeof DocumentPullError>;
