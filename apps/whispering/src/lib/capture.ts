/**
 * Audio capture for one recording at a time. Stop answers once the audio is
 * in the folder (`recordings/<id>.<ext>`), with how long it plays. On the
 * desktop the shell writes Opus in WebM at `recordings/<id>.webm` from its
 * first second and finishes it there at Stop; a crash keeps what reached
 * the disk as it is (ADR-0962). In a browser the take is kept
 * in memory and written once at Stop; a crash or a closed tab loses it
 * (ADR-0779, ADR-0780).
 *
 * The microphone device (`microphone.ts`) records with `@epicenter/recorder`'s
 * `recorder`, which chooses the shell's or the page's microphone, and lists
 * and tests inputs through it too; every failure here is that package's
 * `RecorderError`.
 */
import type {
	Recorder,
	RecorderError,
	Recording,
	RecordingInput,
} from '@epicenter/recorder';
import type { Result } from 'wellcrafted/result';

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

/** What records each recording into Whispering's files: `app.ts` makes one over the microphone. */
export type CaptureDevice = {
	/** The inputs to choose and test: the recorder's own. */
	readonly inputs: Pick<
		Recorder,
		'listInputs' | 'openMeter' | 'allow' | 'onInputsChange'
	>;
	start(options: CaptureStart): Promise<Result<Capture, RecorderError>>;
};
