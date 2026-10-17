/**
 * The recording contract both hosts implement (ADR-0543).
 *
 * A recording is a file in its folder. On the desktop the shell's recorder
 * creates `<path>.wav` when the recording starts and appends to it as it
 * captures, so a quit or a crash keeps the audio up to the cut, and
 * `recoverRecordings` repairs its header the next time the folder opens. In a
 * browser the page records in memory and writes `<path>.<extension>` on stop,
 * so a refresh loses the recording in progress.
 *
 * Nothing here says whether a recording is running. That is the live handle
 * `startRecording` returns; it ends with the page.
 *
 * This is the package's bare entry, the same file for every build: shared
 * code names these types and errors, and a build reaches an implementation
 * only through `@epicenter/recorder/tauri` or `@epicenter/recorder/browser`.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

/**
 * The folder a recording is written into: its ID, which names the scope the
 * desktop shell granted this window, and the write a browser writes through.
 * A handle from `@epicenter/folder` supplies `write`, the folder's one write,
 * which places a recording as a write from no file; its ID is the one it was
 * opened with.
 */
export type RecordingFolder = {
	readonly id: string;
	write(
		path: string,
		from: null,
		to: Uint8Array,
	): Promise<Result<unknown, { readonly message: string }>>;
};

/** A microphone the person chose, asked for by its ID. */
export type RecordingInput = {
	/** The ID the browser lists it under, or on the desktop the ID the shell lists it under (`listInputs`). */
	readonly deviceId: string;
	/** Its name, for a refusal that says which microphone is not connected. */
	readonly label: string;
};

export type StartRecordingOptions = {
	readonly folder: RecordingFolder;
	/** Folder-relative, without an extension, such as `recordings/2026-10-15-0930`. */
	readonly path: string;
	/** Undefined is the system default. A chosen input that is not connected is refused, never replaced. */
	readonly input?: RecordingInput;
	/** Withdraws the start. A microphone that opens afterward is released and nothing is kept. */
	readonly signal?: AbortSignal;
};

/** Why the host ended a capture nobody asked to end. What was captured is still the recording's. */
export type RecordingEndedReason =
	| 'deviceDisconnected'
	| 'permissionRevoked'
	| 'streamFailed'
	| 'storageFailed';

export type StoppedRecording = {
	/** The folder-relative path of the audio file. */
	readonly path: string;
	readonly durationMs: number;
};

/** One recording in progress, owned by the page that started it. */
export type Recording = {
	/**
	 * The audio file this recording is, folder-relative: `<path>.wav` on the
	 * desktop, already in the folder; `<path>.<extension>` in a browser,
	 * written on stop.
	 */
	readonly path: string;
	/** `Date.now()` when capture began. */
	readonly startedAt: number;
	/** The name of the microphone that is recording. */
	readonly device: string;
	/** Hear how loud the input is, from 0 to 1, about twenty times a second. Returns the unsubscribe. */
	onLevel(listener: (level: number) => void): () => void;
	/** Hear that capture ended on its own. `stop` still keeps what was captured. Returns the unsubscribe. */
	onEnded(listener: (reason: RecordingEndedReason) => void): () => void;
	/** Finish the file and release the microphone. */
	stop(): Promise<Result<StoppedRecording, RecorderError>>;
	/** Release the microphone and delete the file. */
	cancel(): Promise<Result<undefined, RecorderError>>;
};

export type RecoverRecordingsOptions = {
	readonly folder: RecordingFolder;
	/** The folder-relative directory recordings are kept in, such as `recordings`. */
	readonly under: string;
};

export type StartRecording = (
	options: StartRecordingOptions,
) => Promise<Result<Recording, RecorderError>>;

/** Returns the folder-relative paths whose headers were rewritten. */
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
	/** The recording was already stopped or cancelled, or is not this page's. */
	NotRecording: ({ reason }: { reason: string }) => ({
		message: `There is no such recording to end: ${reason}`,
		reason,
	}),
	/** The folder or the path may not be recorded into, or a file is already there. */
	Refused: ({ reason }: { reason: string }) => ({
		message: `The recording could not be saved there: ${reason}`,
		reason,
	}),
	/** The start was withdrawn. Anything that opened late was released. */
	Cancelled: () => ({
		message: 'The microphone was not opened: the request was cancelled.',
	}),
	/** The recording captured no audio, so no file was written. */
	Empty: () => ({
		message: 'The recording contained no audio.',
	}),
	Failed: ({ cause }: { cause: unknown }) => ({
		message: `The recording failed: ${cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : String(cause)}`,
		cause,
	}),
});
export type RecorderError = InferErrors<typeof RecorderError>;
