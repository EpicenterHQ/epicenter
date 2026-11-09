/**
 * Why opening a folder failed (`OpenFolderError`).
 *
 * Library messages state the failure precisely; the application decides what
 * a person is told.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Why a folder (`openFolder`) did not open, on every platform. A desktop folder can be disconnected, refused or
 * unreadable; storage itself can be unavailable anywhere (outside Tauri, a
 * browser that gives the page no private storage, a shell that did not
 * answer). Each message says what happened in words a person can act on; the
 * app decides what it offers.
 */
export const OpenFolderError = defineErrors({
	/** The folder is a link to `target`, which is not there, as on a drive that is not connected. Nothing was made. */
	Disconnected: ({ folder, target }: { folder: string; target: string }) => ({
		message: `${folder} is a link to ${target}, a place that isn't available, such as a disconnected drive.`,
		folder,
		target,
	}),
	/** A place an app's folder can never be (the home folder, a folder holding it, or the library root), why in one line. */
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
export type OpenFolderError = InferErrors<typeof OpenFolderError>;

/**
 * A read of a folder's stored data before the folder connected: a mistake
 * in the code that made it, since nothing that reads a store renders before
 * `<WhenOpen>` (ADR-0778). Code that runs before the connection calls an
 * action, which waits.
 */
export class FolderNotOpen extends Error {
	override readonly name = 'FolderNotOpen';
	constructor(what: string) {
		super(
			`${what} was read before the folder connected: read it once the folder is open (inside <WhenOpen>), or await an action such as list()`,
		);
	}
}

/**
 * Why a write the folder was keeping is not made: the folder failed or
 * closed while it waited (ADR-0782). It stops what depended on the write;
 * the folder's state says why.
 */
export class FolderClosed extends Error {
	override readonly name = 'FolderClosed';
	constructor(readonly status: 'failed' | 'closed') {
		super(
			status === 'failed'
				? 'The folder failed to open, so a write waiting for it was not made'
				: 'The folder was closed, so a write waiting for it was not made',
		);
	}
}

/** Why the desktop shell could not show a named root in the file manager. */
export const RevealRootError = defineErrors({
	Failed: ({ cause }: { cause: unknown }) => ({
		message: `Could not show this folder: ${describe(cause)}`,
		cause,
	}),
});
export type RevealRootError = InferErrors<typeof RevealRootError>;

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
