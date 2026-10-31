/**
 * The recording vocabulary both hosts share (ADR-0543).
 *
 * On the desktop a recording is a file in its folder: the shell's recorder
 * creates `<path>.wav` when the recording starts and appends to it as it
 * captures, so a quit or a crash keeps the audio up to the cut, and
 * `recoverRecordings` repairs its header the next time the folder opens
 * (`StartRecording`, `Recording`). In a browser the page records in memory
 * and `stop` answers the audio itself, for the app to keep where it keeps
 * files (`@epicenter/recorder/browser`); a refresh loses the recording in
 * progress.
 *
 * Nothing here says whether a recording is running. That is the live handle
 * a start returns; it ends with the page.
 *
 * This is the package's bare entry, the same file for every build: shared
 * code names these types and errors, and a build reaches an implementation
 * only through `@epicenter/recorder/tauri` or `@epicenter/recorder/browser`.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

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
	 * browser has kept nothing yet; on the desktop what the shell already
	 * wrote is finalized and kept, never deleted.
	 */
	readonly signal?: AbortSignal;
};

/**
 * Which folder a desktop recording is in: the window's own when absent, or
 * a root the page opened with the folder plugin, by the exact path the
 * shell answered (a standalone app's data folder). The shell refuses any
 * root the page did not open.
 */
export type RecordingRoot = {
	readonly root?: string;
};

/** A desktop start: where in the shell's folder the recording is written. */
export type StartRecordingOptions = RecordingStart &
	RecordingRoot & {
		/** Folder-relative, without an extension, such as `recordings/2026-10-15-0930`. */
		readonly path: string;
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

/**
 * One recording in progress, owned by the page that started it. `stop`
 * answers `TStopped`: on the desktop where its file is, in a browser the
 * audio itself.
 */
export type RecordingHandle<TStopped> = {
	/** `Date.now()` when capture began. */
	readonly startedAt: number;
	/** The name of the microphone that is recording. */
	readonly device: string;
	/** Hear how loud the input is, from 0 to 1, about twenty times a second. Returns the unsubscribe. */
	onLevel(listener: (level: number) => void): () => void;
	/** Hear that capture ended on its own, including an ending before subscription. `stop` keeps what was captured. Retired by stop. */
	onEnded(listener: (reason: RecordingEndedReason) => void): () => void;
	/**
	 * Finish the recording and release the microphone. Nothing deletes a
	 * recording: one its page leaves without stopping is finalized by the
	 * shell on the desktop and lost with the page in a browser.
	 */
	stop(): Promise<Result<TStopped, RecorderError>>;
};

/** A desktop recording: `<path>.wav`, in the shell's folder from the first sample. */
export type Recording = RecordingHandle<StoppedRecording> & {
	/** The audio file this recording is, folder-relative: `<path>.wav`. */
	readonly path: string;
};

export type RecoverRecordingsOptions = RecordingRoot & {
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
	/** The recording was already stopped, or is not this page's. */
	NotRecording: ({ reason }: { reason: string }) => ({
		message: `There is no such recording to end: ${reason}`,
		reason,
	}),
	/** The desktop folder or the path may not be recorded into, or a file is already there. */
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
