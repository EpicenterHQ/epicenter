import { defineErrors, type InferErrors } from 'wellcrafted/error';

export const RuntimeError = defineErrors({
	RecordNotLive: ({ address }: { address: string }) => ({
		message: `Record '${address}' is not live`,
		address,
	}),
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
	RevokedDocument: ({ address }: { address: string }) => ({
		message: `Row document '${address}' was revoked because its record is no longer live`,
		address,
	}),
});

export type RuntimeError = InferErrors<typeof RuntimeError>;
export type RecordNotLiveError = Extract<
	RuntimeError,
	{ name: 'RecordNotLive' }
>;
export type BlobAlreadyCapturedError = Extract<
	RuntimeError,
	{ name: 'BlobAlreadyCaptured' }
>;
export type BlobSourceReadError = Extract<
	RuntimeError,
	{ name: 'BlobSourceRead' }
>;
export type RevokedDocumentError = Extract<
	RuntimeError,
	{ name: 'RevokedDocument' }
>;
