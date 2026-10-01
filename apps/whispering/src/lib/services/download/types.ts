import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const DownloadError = defineErrors({
	SaveDialogFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to open save dialog: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SaveCancelled: () => ({
		message: 'Please specify a path to save the recording.',
	}),
	WriteFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to write file: ${extractErrorMessage(cause)}`,
		cause,
	}),
	BrowserDownloadFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to download in browser: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type DownloadError = InferErrors<typeof DownloadError>;

export type DownloadService = {
	downloadBlob: (args: {
		/** Complete filename, including the extension chosen by the caller. */
		name: string;
		blob: Blob;
	}) => Promise<Result<void, DownloadError>>;
};
