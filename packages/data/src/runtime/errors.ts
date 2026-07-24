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

export const RuntimeError = {
	...RecordHandleError,
	...BlobCaptureError,
	...RowDocumentError,
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
export type RuntimeError =
	| RecordNotLiveError
	| BlobCaptureError
	| RevokedDocumentError;
