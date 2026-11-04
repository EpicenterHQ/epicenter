/**
 * The recording vocabulary both hosts share (ADR-0543, decision 84), and
 * `Recorder`, the one interface both implement.
 *
 * A recording is a file in the app's store from its first moments, written
 * as it records, so a quit, a crash, or a closed tab keeps the audio up to
 * the cut (`Recorder.start`, `Recording`). `Recorder.recover`, run when the
 * store opens, repairs what a cut left half-written. Every build calls the
 * same `recorder`; which one a build runs is the entry it imports
 * (`@epicenter/recorder/tauri` or `@epicenter/recorder/browser`), chosen by
 * the app's `#platform` seam, never at run time:
 *
 * - On the desktop the shell's recorder encodes the microphone to Opus from
 *   the first sample and writes it, a second at a time, into a WebM in the
 *   data folder's `.epicenter/recordings`; Stop finishes it in place and
 *   places it at `<path>.webm`; recovery finishes one a cut left from its
 *   whole seconds and places it the same way.
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
import type { FolderLifecycle } from '@epicenter/folder/core';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export { audioDurationMs } from './container.js';

/** A microphone the person chose, asked for by its ID. */
export type RecordingInput = {
	/** The ID `Recorder.listInputs` answers it under: the browser's, or on the desktop the shell's. */
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
 * The folder a recording is written into: the app's own (`openFolder`), or
 * `reactive`'s copy of it, so the audio stays where the rest of its files
 * are. On the desktop that is the data folder, whose root the shell writes
 * into; in a browser, this origin's private files, appended to as the
 * recording runs (`filesOf` from `@epicenter/folder/browser`).
 */
export type RecordingFolder = {
	readonly folder: FolderLifecycle;
};

/** Where a recording is written. */
export type StartRecordingOptions = RecordingStart &
	RecordingFolder & {
		/**
		 * Store-relative, without an extension, such as
		 * `recordings/2026-10-15-0930`: the extension is the format's (`webm`
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

/** A stopped recording: its audio, at its path when `stop` answers. */
export type StoppedRecording = {
	/** The store-relative path of the audio file, extension included. */
	readonly path: string;
	/**
	 * How long the file plays: on the desktop its samples over their rate, in
	 * a browser read from the file written (an engine drops the first moments
	 * of a recording, so the time between Start and Stop is longer).
	 */
	readonly durationMs: number;
};

/**
 * One recording in progress, owned by the page that started it, written
 * into the store as it records: in a browser at `<path>.<ext>`, on the
 * desktop in the folder's `.epicenter/recordings` until `stop` places it at
 * `<path>.webm`. Where its audio is, extension included, is what `stop`
 * answers.
 */
export type Recording = {
	/** Hear that capture ended on its own, including an ending before subscription. `stop` keeps what was captured. Retired by stop. */
	onEnded(listener: (reason: RecordingEndedReason) => void): () => void;
	/**
	 * Finish the recording and release the microphone; answers once its
	 * file is finished at its path. Nothing deletes a recording: one its
	 * page leaves without stopping is finished and placed by the shell on
	 * the desktop, and in a browser is the pieces already written, which
	 * `recover` repairs.
	 */
	stop(): Promise<Result<StoppedRecording, RecorderError>>;
};

/** A recording `Recorder.recover` repaired. */
export type RecoveredRecording = {
	/** The store-relative path of its audio file. */
	readonly path: string;
	/**
	 * How long it plays, as `stop` would have answered: on the desktop as
	 * its finished file states, in a browser read from the file repaired.
	 * Null when its audio does not read as the format it is named for.
	 */
	readonly durationMs: number | null;
};

/**
 * A recording `Recorder.recover` finished but did not place, because
 * another file is at its path. Its audio is kept, finished, at `pending`
 * until a person moves one of the two; nothing deletes it. Only the desktop
 * has one: a browser recording is written at its path.
 */
export type UnplacedRecording = {
	/** The store-relative path it was not placed at: another file is there. */
	readonly path: string;
	/** Where its audio is, store-relative, under `.epicenter/recordings`. */
	readonly pending: string;
};

/** What `Recorder.recover` did. */
export type Recovery = {
	/** Each recording repaired, or whole, at its path. */
	readonly recovered: readonly RecoveredRecording[];
	/** Each recording left outside its path, because another file is there. */
	readonly unplaced: readonly UnplacedRecording[];
};

export type RecoverRecordingsOptions = RecordingFolder & {
	/** The store-relative directory recordings are kept in, such as `recordings`. */
	readonly under: string;
	/**
	 * The audio files under `under` that the app keeps no record of yet, by
	 * store-relative path (`recordings/a.webm`): the only place a browser's
	 * cut-off recording can be, and on the desktop audio a page left before
	 * writing its note.
	 */
	readonly unnamed: readonly string[];
};

/** A microphone open for its level only: nothing is recorded or written. */
export type Meter = {
	/** The name of the microphone that is open. */
	readonly microphone: string;
	/** Hear how loud the input is, from 0 to 1, at most twenty times a second. Returns the unsubscribe. */
	onLevel(listener: (level: number) => void): () => void;
	/** Hear the first unexpected ending, including one before subscription. Retired by close. */
	onEnded(listener: (reason: RecordingEndedReason) => void): () => void;
	/** Release the microphone. */
	close(): Promise<void>;
};

/** The inputs connected now, as `Recorder.listInputs` answers them. */
export type InputListing = {
	/** Each input that can be chosen by name, by the ID to record or meter it by. */
	readonly inputs: readonly RecordingInput[];
	/**
	 * Inputs exist, but the browser withholds their names until microphone
	 * access is allowed (`Recorder.allow`). Absent on the desktop, whose
	 * shell names every input without access.
	 */
	readonly namesWithheld?: boolean;
};

/**
 * What a host does with its microphones: the `recorder` that
 * `@epicenter/recorder/tauri` and `@epicenter/recorder/browser` each export.
 * Its functions need no `this`, so each can be passed on its own.
 */
export type Recorder = {
	/** Record from `input`, or the system default, into `folder` at `path`. */
	readonly start: (
		options: StartRecordingOptions,
	) => Promise<Result<Recording, RecorderError>>;
	/**
	 * Repair the recordings under a directory that a quit, a crash, or a
	 * closed tab cut off, leaving any recording still being written alone,
	 * and answer in `recovered` each recording the app should now record:
	 * every one it finished and placed, and every one of `unnamed` whose
	 * audio is whole at its path, with how long it plays when it read that
	 * (null when it did not). How a build tells a whole recording from a cut
	 * one is its own: the desktop shell records outside the path and places
	 * a recording there only whole, so it always looks for cut-off ones;
	 * a browser writes at the path as it records, so it looks only among
	 * `unnamed`, past any another tab is still writing. It also answers
	 * `unplaced`, every time it runs, each recording it left outside its
	 * path because another file is there, which an app says to the person.
	 */
	readonly recover: (
		options: RecoverRecordingsOptions,
	) => Promise<Result<Recovery, RecorderError>>;
	/** The inputs connected now. Opens nothing, and never asks for access. */
	readonly listInputs: () => Promise<Result<InputListing, RecorderError>>;
	/**
	 * Open `input`, or the system default, for its level until `close`. A
	 * chosen input that is not connected is refused, never replaced.
	 */
	readonly openMeter: (
		options?: RecordingStart,
	) => Promise<Result<Meter, RecorderError>>;
	/**
	 * Ask for microphone access, so inputs are listed by name: the system
	 * default microphone is opened and released at once, and nothing is
	 * recorded or measured. A browser's alone: the desktop shell names inputs
	 * without access, and asks for it itself before it opens a microphone.
	 */
	readonly allow?: (
		options?: Pick<RecordingStart, 'signal'>,
	) => Promise<Result<undefined, RecorderError>>;
	/**
	 * Hear inputs connected or removed; returns the unsubscribe. A browser's
	 * alone, and not every browser says: the desktop shell announces nothing,
	 * so listing again is always offered.
	 */
	readonly onInputsChange?: (listener: () => void) => () => void;
};

export const RecorderError = defineErrors({
	/** This window cannot record: no microphone access, or no encoder. */
	Unavailable: ({ reason }: { reason: string }) => ({
		message: `Recording is not available here: ${reason}`,
		reason,
	}),
	/** The system or the browser refused microphone access. */
	PermissionDenied: () => ({
		message:
			'Microphone access was denied. Allow microphone access in System Settings, under Privacy and Security, or in this browser’s site settings, then try again.',
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
