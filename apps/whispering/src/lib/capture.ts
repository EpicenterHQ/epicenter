/**
 * Audio capture for one recording at a time. Every capture writes the
 * recording's audio into Whispering's store as it records, so a quit, a
 * crash, or a closed tab keeps everything up to the cut (decision 84): on
 * the desktop the shell writes Opus in WebM from the first sample outside
 * the recording's path and places it there at Stop, in a browser each piece
 * is appended to this browser's files at its path (`recordings/<id>.<ext>`)
 * as it arrives. Stop answers once the audio is at its path, with how long
 * it plays; and `recover` repairs the audio a cut left half-written.
 *
 * The microphone device (`microphone.ts`) records with `@epicenter/recorder`'s
 * `recorder`, from the entry the build's platform leaf imports, and lists
 * and tests inputs through it too; every failure here is that package's
 * `RecorderError`.
 */
import type {
	Recorder,
	RecorderError,
	Recording,
	RecordingInput,
	UnplacedRecording,
} from '@epicenter/recorder';
import type { Result } from 'wellcrafted/result';

/** What `CaptureDevice.recover` answers. */
export type Recovered = {
	readonly whole: readonly {
		readonly id: string;
		readonly durationMs: number | null;
	}[];
	readonly unplaced: readonly UnplacedRecording[];
};

/** A recording being written into Whispering's files. */
export type Capture = {
	/** `performance.now()` when capture began, for the elapsed-time display. */
	readonly startedAt: number;
	/** Hear capture end unexpectedly; stop still keeps what was captured. Retired by stop. */
	onEnded: Recording['onEnded'];
	/** Finish the file at its path and release the microphone. */
	stop(): Promise<Result<StoppedCapture, RecorderError>>;
};

/** A recording whose capture has finished, its audio at its path (`recordings/<id>.<ext>`). */
export type StoppedCapture = {
	/** How long its audio plays. */
	readonly durationMs: number;
};

export type CaptureStart = {
	/** The recording's id: the audio is written to `recordings/<id>.<ext>`. */
	readonly id: string;
	/** The microphone to record from. Undefined is the system default. */
	readonly input?: RecordingInput;
	/** Withdraws the start. A microphone that opens afterward is released. */
	readonly signal?: AbortSignal;
};

/** What records each recording into Whispering's files: the build's services choose one. */
export type CaptureDevice = {
	/** The inputs to choose and test: the recorder's own. */
	readonly inputs: Pick<
		Recorder,
		'listInputs' | 'openMeter' | 'allow' | 'onInputsChange'
	>;
	start(options: CaptureStart): Promise<Result<Capture, RecorderError>>;
	/**
	 * Repair the audio of recordings a quit, a crash, or a closed tab cut
	 * off, and answer each recording whose audio is whole at its path and
	 * may have no note (`whole`), by id, with how long it plays (null: read
	 * it to measure). `unnamed` is the audio at its path no note names, by
	 * store-relative path (`recordings/<id>.<ext>`); one another tab is still
	 * writing is left out. It also answers each recording kept outside its
	 * path because another file is there (`unplaced`), which no note can
	 * name. Where a cut-off recording waits is the recorder's to know.
	 */
	recover(
		unnamed: readonly string[],
	): Promise<Result<Recovered, RecorderError>>;
};
