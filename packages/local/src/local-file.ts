/**
 * What every build's `localFile(name)` answers: one text file a capability
 * keeps on this computer, in the app's one place for such state, which the
 * build picks (ADR-0766). App code never opens or names that place.
 *
 * | Build | The place |
 * | --- | --- |
 * | desktop (`tauri`) | the app's AppData root, through the shell |
 * | web (`default`) | this browser's storage for the site |
 * | `test` | memory, empty at first |
 *
 * A write carries the version its writer read and lands only while the file
 * still holds it, so two windows never overwrite each other unseen.
 */
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

/** A file as read: its text, and the version to write over. */
export type LocalText = { readonly text: string; readonly version: string };

export const LocalFileError = defineErrors({
	/** The place could not be read or written: the shell refused, or the browser keeps no storage. */
	Unavailable: ({ cause }: { cause: unknown }) => ({
		message: `The settings on this computer could not be reached: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type LocalFileError = InferErrors<typeof LocalFileError>;

/** One file in the app's place on this computer. */
export type LocalFile = {
	/** The file's text and version, or null when it is not there. */
	read(): Promise<Result<LocalText | null, LocalFileError>>;
	/**
	 * Write `text`, or remove the file for null, only while the file holds
	 * `over` (`'absent'` for a file that is not there): the version written
	 * (`'absent'` after a removal), or `'stale'` when the file held another,
	 * and nothing changed.
	 */
	write(
		text: string | null,
		over: string,
	): Promise<Result<{ version: string } | 'stale', LocalFileError>>;
	/**
	 * Call `listener` when the file may have changed: a write here, in
	 * another window, or by hand. Returns the unsubscribe.
	 */
	subscribe(listener: () => void): () => void;
};

/** `localFile` on every build: one signature, so either build's code typechecks against one. */
export type OpenLocalFile = (name: string) => LocalFile;

/** Listeners by file name, for the writes a leaf makes itself. */
export function createListeners() {
	const byName = new Map<string, Set<() => void>>();
	return {
		add(name: string, listener: () => void) {
			let listeners = byName.get(name);
			if (listeners === undefined) {
				listeners = new Set();
				byName.set(name, listeners);
			}
			const own = listeners;
			own.add(listener);
			return () => {
				own.delete(listener);
			};
		},
		emit(name: string) {
			for (const listener of [...(byName.get(name) ?? [])]) listener();
		},
	};
}
