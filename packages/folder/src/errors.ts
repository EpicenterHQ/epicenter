/**
 * Why opening a contract's client failed (`OpenDeviceError`).
 *
 * Library messages state the failure precisely; the application decides what
 * a person is told.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Why `openDevice` opened no client, on every platform. A desktop data
 * folder can be missing, disconnected, not granted, refused or unreadable; storage itself
 * can be unavailable anywhere (outside Tauri, a browser that gives the page
 * no private storage, a shell that did not answer). Each message says what
 * happened in words a person can act on; the app decides what it offers.
 */
export const OpenDeviceError = defineErrors({
	/** The folder is not there: moved, deleted, or on a drive not connected. Never made again on its own. */
	Missing: ({ folder }: { folder: string }) => ({
		message: `${folder} is not there. It may have been moved or deleted, or be on a drive that is not connected.`,
		folder,
	}),
	/** The folder is reached through a link to `target`, which is not there, as on a drive that is not connected. Nothing was made. */
	Disconnected: ({ folder, target }: { folder: string; target: string }) => ({
		message: `${folder} is on a drive that is not connected: it links to ${target}, which is not there. Connect the drive and open this app again.`,
		folder,
		target,
	}),
	/** Tauri's file-system scope does not allow the folder: it was named without the folder picker. */
	NotGranted: ({ folder }: { folder: string }) => ({
		message: `This app has not been allowed to open ${folder}. Choose it in the folder picker to allow it.`,
		folder,
	}),
	/** A place no app keeps its files in (the home folder, a .git folder, Epicenter's own settings), why in one line. */
	Refused: ({ folder, reason }: { folder: string; reason: string }) => ({
		message: reason,
		folder,
		reason,
	}),
	/** The folder is there but could not be opened or made. */
	Unreadable: ({ folder, cause }: { folder: string; cause: unknown }) => ({
		message: `${folder} could not be opened: ${describe(cause)}`,
		folder,
		cause,
	}),
	/** This platform's storage could not be reached at all. */
	StorageUnavailable: ({ cause }: { cause: unknown }) => ({
		message: `This app's storage is not available: ${describe(cause)}`,
		cause,
	}),
});
export type OpenDeviceError = InferErrors<typeof OpenDeviceError>;

function describe(cause: unknown): string {
	if (cause instanceof Error) return cause.message;
	if (
		typeof cause === 'object' &&
		cause !== null &&
		'message' in cause &&
		typeof cause.message === 'string'
	)
		return cause.message;
	return String(cause);
}
