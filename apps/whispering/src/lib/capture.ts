/**
 * Audio capture for one recording at a time. Every capture writes the
 * recording's audio into Whispering's store as it records, so a quit, a
 * crash, or a closed tab keeps everything up to the cut (decision 84): on
 * the desktop the shell writes a WAV from the first sample outside the
 * recording's path, in a browser each piece is appended to this browser's
 * files at its path (`recordings/<id>.<ext>`) as it arrives. Stop answers
 * how long its audio plays and, once the audio is at its path, where; and
 * `recover` repairs the audio a cut left half-written.
 *
 * The microphone device (`microphone.ts`) records with `@epicenter/recorder`,
 * whose entry the build's platform leaf imports, and every failure here is
 * that package's `RecorderError`.
 */
import type { RecorderError, RecordingHandle } from '@epicenter/recorder';
import type { Result } from 'wellcrafted/result';

/** A recording being written into Whispering's files. */
export type Capture = {
	/** `performance.now()` when capture began, for the elapsed-time display. */
	readonly startedAt: number;
	/** Hear capture end unexpectedly; stop still keeps what was captured. Retired by stop. */
	onEnded: RecordingHandle<unknown>['onEnded'];
	/** Finish the file and release the microphone. */
	stop(): Promise<Result<StoppedCapture, RecorderError>>;
};

/** A recording whose capture has finished. */
export type StoppedCapture = {
	/** How long its audio plays. */
	readonly durationMs: number;
	/**
	 * Resolves once its audio is at its path (`recordings/<id>.<ext>`): at
	 * once in a browser, on the desktop once the shell has encoded and
	 * placed it, after Stop answered. `unencoded` says why the desktop kept a
	 * WAV. An error is audio left outside its path, which the next start's
	 * `recover` places. Never rejects.
	 */
	readonly placed: Promise<
		Result<{ readonly unencoded?: string }, RecorderError>
	>;
};

/** A microphone the person chose by name. Kept on this device, never in Whispering's files. */
export type MicrophonePreference = {
	/** The ID its platform lists it under: the shell's in Epicenter, the WebView's in a browser. Capture asks for exactly this one. */
	readonly deviceId: string;
	/** Its name when it was chosen, shown when it is not connected. */
	readonly label: string;
};

export type MicrophoneListing = {
	/** Inputs that can be chosen by name. Empty until microphone access is allowed. */
	readonly devices: readonly MicrophonePreference[];
	/**
	 * Inputs exist but a WebView withholds their names until access is
	 * allowed. Absent where names are never withheld: Epicenter's shell lists
	 * every input by name, whether or not access was allowed.
	 */
	readonly namesWithheld?: boolean;
};

/** A live reading of one microphone that records, sends, and saves nothing. */
export type MicrophoneMeter = {
	/** The name of the microphone that is open. */
	readonly label: string;
	/** How loud the input is now, from 0 to 1. */
	level(): number;
	/**
	 * Hear that the microphone stopped on its own, such as when it was
	 * unplugged or access was withdrawn, and why. Returns the unsubscribe.
	 */
	onEnded(listener: (error: RecorderError) => void): () => void;
	/** Release the microphone. */
	stop(): void;
};

/** The inputs behind a capture device. */
export type MicrophoneInputs = {
	/**
	 * The inputs connected now. This never asks for access: without it a
	 * WebView lists nothing by name.
	 */
	list(): Promise<Result<MicrophoneListing, RecorderError>>;
	/**
	 * Ask for microphone access so inputs are listed by name. This opens the
	 * system default microphone and releases it at once; nothing is recorded.
	 * Only a WebView has it: in Epicenter the shell asks for access itself
	 * before it opens a microphone, and lists names without it.
	 */
	allow?(signal?: AbortSignal): Promise<Result<undefined, RecorderError>>;
	/**
	 * Open the system's microphone privacy settings, where access that was
	 * denied is allowed again. Absent where the page cannot open them.
	 */
	openSettings?(): Promise<Result<undefined, RecorderError>>;
	/** Open `input`, or the system default, for a level reading only. */
	meter(
		input: MicrophonePreference | undefined,
		signal?: AbortSignal,
	): Promise<Result<MicrophoneMeter, RecorderError>>;
	/**
	 * Hear that inputs were connected or removed. Not every platform says so,
	 * which is why listing again is always offered.
	 */
	onChange(listener: () => void): () => void;
};

export type CaptureStart = {
	/** The recording's id: the audio is written to `recordings/<id>.<ext>`. */
	readonly id: string;
	/** The microphone to record from. Undefined is the system default. */
	readonly input?: MicrophonePreference;
	/** Withdraws the start. A microphone that opens afterward is released. */
	readonly signal?: AbortSignal;
};

/** What records each recording into Whispering's files: the build's services choose one. */
export type CaptureDevice = {
	readonly inputs: MicrophoneInputs;
	start(options: CaptureStart): Promise<Result<Capture, RecorderError>>;
	/**
	 * Repair the audio of recordings a quit, a crash, or a closed tab cut
	 * off, and answer each recording whose audio is whole at its path and
	 * may have no note, by id, with how long it plays (null: read it to
	 * measure). `unnamed` is the audio at its path no note names. In a
	 * browser that is the only place a cut-off recording can be, and one
	 * another tab is still writing is left out; on the desktop a cut-off
	 * recording waits outside its path, so it is always looked for, and audio
	 * reaches its path only whole.
	 */
	recover(
		unnamed: readonly string[],
	): Promise<
		Result<
			{ readonly id: string; readonly durationMs: number | null }[],
			RecorderError
		>
	>;
};
