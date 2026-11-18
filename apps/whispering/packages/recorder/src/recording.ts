/**
 * The recording vocabulary both hosts share (ADR-0543, decision 84), and
 * `Recorder`, the one interface both implement.
 *
 * A recording's audio is at its path when it stops (`Recorder.start`,
 * `Recording`). Every page calls the same `recorder` from
 * `@epicenter/recorder`, which `index.ts` chooses when it loads: the
 * shell's in a Tauri window, the page's own in a browser (ADR-0781). The
 * two need not promise the same things (ADR-0780):
 *
 * - On the desktop the shell's recorder encodes the microphone to Opus from
 *   the first sample and writes it, a second at a time, at
 *   `recordings/<id>.webm` in the folder; Stop finishes it there
 *   (ADR-0962). The shell outlives the page, so a quit or a crash keeps
 *   every whole second written, which plays as it is.
 * - In a browser the page keeps each piece `MediaRecorder` hands over in
 *   memory, and Stop writes the take once with `files.write` at
 *   `recordings/<id>.m4a` (or `.webm`) (ADR-0779). A crash or a closed tab
 *   loses the take; the leave guard asks before a page closes while one
 *   runs.
 *
 * Nothing here says whether a recording is running. That is the live handle
 * a start returns; it ends with the page.
 *
 * Shared code names these types, errors, and `audioDurationMs`; each
 * implementation (`tauri.ts`, `browser.ts`) re-exports them.
 */
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
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
 * The app's folder, as a recording is written into it: Whispering's
 * `Files`, and on the desktop where the folder is, which the shell records
 * a take into itself. Paths are folder-relative (`recordings/k3x9.webm`).
 */
export type AudioFiles = {
	/** The folder's absolute path on this computer; null where it has none (a browser's). */
	readonly location: string | null;
	/** The file's bytes, or null when nothing is there. */
	read(path: string): Promise<Result<Uint8Array | null, { message: string }>>;
	/** Write the file whole. */
	write(
		path: string,
		bytes: Uint8Array,
	): Promise<Result<undefined, { message: string }>>;
};

/**
 * The folder a recording is written into, so the audio stays where the rest
 * of the app's files are. On the desktop the shell records the take there
 * itself; in a browser Stop writes it once (`files.write`).
 */
export type RecordingFiles = {
	readonly files: AudioFiles;
};

/** The directory a recording's audio is in, folder-relative. */
export const RECORDINGS = 'recordings';

/** Which recording to make. */
export type StartRecordingOptions = RecordingStart &
	RecordingFiles & {
		/**
		 * The recording's id: its audio is at `recordings/<id>.<ext>`,
		 * where the extension is the format's (`webm` on the desktop; `m4a` or
		 * `webm` in a browser). Refused when audio with this id is there.
		 */
		readonly id: string;
	};

/** Why the host ended a capture nobody asked to end. What was captured is still the recording's. */
export type RecordingEndedReason =
	| 'deviceDisconnected'
	| 'permissionRevoked'
	| 'streamFailed'
	| 'storageFailed';

/** A stopped recording: its audio, at `recordings/<id>.<ext>` when `stop` answers. */
export type StoppedRecording = {
	readonly id: string;
	/**
	 * How long the take plays: on the desktop its samples over their rate, in
	 * a browser the recorder's own clock, the time it spent recording with
	 * its pauses left out.
	 */
	readonly durationMs: number;
};

/**
 * One recording in progress, owned by the page that started it: in a
 * browser kept in memory until `stop` writes it at `recordings/<id>.<ext>`,
 * on the desktop written at `recordings/<id>.webm` from its first second
 * until `stop` finishes it there.
 */
export type Recording = {
	/** Hear that capture ended on its own, including an ending before subscription. `stop` keeps what was captured. Retired by stop. */
	onEnded(listener: (reason: RecordingEndedReason) => void): () => void;
	/**
	 * Finish the recording and release the microphone; answers once its
	 * file is at its path. One its page leaves without stopping is finished
	 * by the shell on the desktop, and lost in a browser.
	 */
	stop(): Promise<Result<StoppedRecording, RecorderError>>;
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
 * What a host does with its microphones: the `recorder` that `tauri.ts` and
 * `browser.ts` each export, and `@epicenter/recorder` chooses between. Its
 * functions need no `this`, so each can be passed on its own.
 */
export type Recorder = {
	/** Record from `input`, or the system default, as recording `id` in `files`. */
	readonly start: (
		options: StartRecordingOptions,
	) => Promise<Result<Recording, RecorderError>>;
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
	/** The folder may not be recorded into, or audio with the recording's id is already there. */
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
		message: `The recording failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type RecorderError = InferErrors<typeof RecorderError>;
