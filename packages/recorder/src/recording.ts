/**
 * The recording vocabulary both hosts share (ADR-0543, decision 84).
 *
 * A recording is a file in the app's store from its first moments, written
 * as it records, so a quit, a crash, or a closed tab keeps the audio up to
 * the cut (`StartRecording`, `Recording`). `recoverRecordings`, run when the
 * store opens, repairs what a cut left half-written. The same two calls
 * serve every build; which one a build runs is the entry it imports
 * (`@epicenter/recorder/tauri` or `@epicenter/recorder/browser`), chosen by
 * the app's `#platform` seam, never at run time:
 *
 * - On the desktop the shell's recorder creates `<path>.wav` in the data
 *   folder and appends PCM from the first sample, updating the header about
 *   once a second; recovery rewrites a header a cut left short.
 * - In a browser the page appends each piece `MediaRecorder` hands over,
 *   about once a second, to `<path>.m4a` (or `.webm`) in this browser's
 *   private files; recovery cuts a file back to its last whole piece.
 *
 * Nothing here says whether a recording is running. That is the live handle
 * a start returns; it ends with the page.
 *
 * This is the package's bare entry, the same file for every build: shared
 * code names these types, errors, and `audioDurationMs`, and a build
 * reaches an implementation only through `@epicenter/recorder/tauri` or
 * `@epicenter/recorder/browser`.
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export { audioDurationMs } from './container.js';

/** A microphone the person chose, asked for by its ID. */
export type RecordingInput = {
	/** The ID the browser lists it under, or on the desktop the ID the shell lists it under (`listInputs`). */
	readonly deviceId: string;
	/** Its name, for a refusal that says which microphone is not connected. */
	readonly label: string;
};

/** What every start takes: which microphone, and a way to withdraw. */
export type RecordingStart = {
	/** Undefined is the system default. A chosen input that is not connected is refused, never replaced. */
	readonly input?: RecordingInput;
	/**
	 * Withdraws the start. A microphone that opens afterward is released. A
	 * browser has written nothing yet; on the desktop what the shell already
	 * wrote is finalized and kept, never deleted.
	 */
	readonly signal?: AbortSignal;
};

/**
 * The store a recording is written into: a client `openDevice` returned,
 * the app's own, so the audio stays where the rest of its files are. On the
 * desktop the data folder (from `@epicenter/folder/tauri`), whose root the
 * shell then writes into; in a browser this origin's private files (from
 * `@epicenter/folder/browser`).
 */
export type RecordingDevice = {
	readonly device: Client<Contract>;
};

/** Where a recording is written. */
export type StartRecordingOptions = RecordingStart &
	RecordingDevice & {
		/**
		 * Store-relative, without an extension, such as
		 * `recordings/2026-10-15-0930`: the extension is the format's (`wav`
		 * on the desktop; `m4a` or `webm` in a browser). Nothing may be there.
		 */
		readonly path: string;
	};

/** Why the host ended a capture nobody asked to end. What was captured is still the recording's. */
export type RecordingEndedReason =
	| 'deviceDisconnected'
	| 'permissionRevoked'
	| 'streamFailed'
	| 'storageFailed';

export type StoppedRecording = {
	/** The store-relative path of the audio file. */
	readonly path: string;
	readonly durationMs: number;
};

/**
 * One recording in progress, owned by the page that started it. `stop`
 * answers `TStopped`: where its file is, or for a recording held in the
 * page (`startPageRecording`) the audio itself.
 */
export type RecordingHandle<TStopped> = {
	/** `Date.now()` when capture began. */
	readonly startedAt: number;
	/** The name of the microphone that is recording. */
	readonly microphone: string;
	/** Hear how loud the input is, from 0 to 1, about twenty times a second. Returns the unsubscribe. */
	onLevel(listener: (level: number) => void): () => void;
	/** Hear that capture ended on its own, including an ending before subscription. `stop` keeps what was captured. Retired by stop. */
	onEnded(listener: (reason: RecordingEndedReason) => void): () => void;
	/**
	 * Finish the recording and release the microphone. Nothing deletes a
	 * recording: one its page leaves without stopping is finalized by the
	 * shell on the desktop, and in a browser is the pieces already written,
	 * which `recoverRecordings` repairs.
	 */
	stop(): Promise<Result<TStopped, RecorderError>>;
};

/** A recording written into the store as it records: `<path>.<ext>`. */
export type Recording = RecordingHandle<StoppedRecording> & {
	/** The audio file this recording is, store-relative: `<path>.wav`, `<path>.m4a`, or `<path>.webm`. */
	readonly path: string;
};

export type RecoverRecordingsOptions = RecordingDevice & {
	/** The store-relative directory recordings are kept in, such as `recordings`. */
	readonly under: string;
};

export type StartRecording = (
	options: StartRecordingOptions,
) => Promise<Result<Recording, RecorderError>>;

/**
 * Repair the recordings under a directory that a quit, a crash, or a closed
 * tab cut off, leaving any recording still being written alone. Answers the
 * store-relative paths it rewrote; a second run rewrites none.
 */
export type RecoverRecordings = (
	options: RecoverRecordingsOptions,
) => Promise<Result<string[], RecorderError>>;

export const RecorderError = defineErrors({
	/** This window cannot record: no microphone access, or no encoder. */
	Unavailable: ({ reason }: { reason: string }) => ({
		message: `Recording is not available here: ${reason}`,
		reason,
	}),
	/** The system or the browser refused microphone access. */
	PermissionDenied: () => ({
		message:
			'Microphone access was denied. Allow it in your system or browser settings, then try again.',
	}),
	/** No microphone is connected, or the system default cannot record. */
	NoInputDevice: ({ reason }: { reason: string }) => ({
		message: `No microphone is available to record from: ${reason}`,
		reason,
	}),
	/** The chosen microphone is not connected. Nothing was recorded from another in its place. */
	InputUnavailable: ({ label }: { label: string }) => ({
		message: `${label === '' ? 'The chosen microphone' : `“${label}”`} is not available, and no other microphone was used in its place. Connect it, or choose another input.`,
		label,
	}),
	/** Another recording holds the host's one recorder. */
	Busy: ({ reason }: { reason: string }) => ({
		message: `Another recording is in progress: ${reason}`,
		reason,
	}),
	/** The recording was already stopped, or is not this page's. */
	NotRecording: ({ reason }: { reason: string }) => ({
		message: `There is no such recording to end: ${reason}`,
		reason,
	}),
	/** The store or the path may not be recorded into, or a file is already there. */
	Refused: ({ reason }: { reason: string }) => ({
		message: `The recording could not be saved there: ${reason}`,
		reason,
	}),
	/**
	 * The request was withdrawn. A microphone that answered late was released;
	 * on the desktop what a late recording had written was kept.
	 */
	Cancelled: () => ({
		message: 'The request was withdrawn before it finished.',
	}),
	/** The recording captured no audio. */
	Empty: () => ({
		message: 'The recording contained no audio.',
	}),
	Failed: ({ cause }: { cause: unknown }) => ({
		message: `The recording failed: ${cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : String(cause)}`,
		cause,
	}),
});
export type RecorderError = InferErrors<typeof RecorderError>;
