import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { WriteTextOutcome } from '$lib/tauri/bindings.gen';

export type { WriteTextOutcome };

type MaybePromise<T> = T | Promise<T>;

export const TextError = defineErrors({
	WriteToCursor: ({ cause }: { cause: unknown }) => ({
		message: `Failed to write text at cursor position: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SimulateKeystroke: ({ cause }: { cause: unknown }) => ({
		message: `Failed to simulate keystroke: ${extractErrorMessage(cause)}`,
		cause,
	}),
	NotSupported: ({ operation }: { operation: string }) => ({
		message: `${operation} is not supported in this environment for security reasons.`,
		operation,
	}),
});
export type TextError = InferErrors<typeof TextError>;

/**
 * Whispering's delivery into other applications: cursor paste and synthetic
 * keystrokes. Plain clipboard reads and writes are not here; they are the
 * shared `clipboard` from `@epicenter/app/clipboard`.
 */
export type TextService = {
	/**
	 * Delivers the provided text to the current cursor position, falling back to
	 * the clipboard when it cannot paste.
	 *
	 * On desktop this decides from the Accessibility grant *before* attempting the
	 * synthetic paste (an untrusted ⌘V silently no-ops). The clipboard is the
	 * paste transport, and `keepOnClipboard` states what the clipboard should hold
	 * afterward: when `true` (clipboard output is on) the transcript is written and
	 * left there; when `false` the call borrows the clipboard (snapshot → write →
	 * ⌘V → restore) so the user's clipboard is preserved, full-fidelity on macOS.
	 * When it cannot paste, it leaves the transcript on the clipboard regardless.
	 * On web it can only ever copy, so it always reports `leftOnClipboard`.
	 *
	 * @returns where the text landed — `pasted` at the cursor, or `leftOnClipboard`.
	 * @param text The text to write at the cursor position.
	 * @param keepOnClipboard Whether to leave the transcript on the clipboard after
	 *   pasting (clipboard output on) instead of restoring the user's clipboard.
	 */
	writeToCursor: (
		text: string,
		keepOnClipboard: boolean,
	) => MaybePromise<Result<WriteTextOutcome, TextError>>;

	/**
	 * Simulates pressing the Enter/Return key.
	 * Useful for automatically submitting text in chat applications after transcription.
	 *
	 * Note: This is only supported on desktop (Tauri). Web browsers cannot simulate keystrokes
	 * for security reasons.
	 */
	simulateEnterKeystroke: () => Promise<Result<void, TextError>>;

	/**
	 * Simulates pressing the copy shortcut (Cmd+C on macOS, Ctrl+C elsewhere) to
	 * copy the active selection in the foreground app to the clipboard. Compose
	 * with a clipboard save/read/restore to capture a selection without clobbering
	 * the user's clipboard (see `captureSelection` in `operations/selection`).
	 *
	 * Note: This is only supported on desktop (Tauri). Web browsers cannot
	 * simulate keystrokes for security reasons.
	 */
	simulateCopyKeystroke: () => Promise<Result<void, TextError>>;
};
