import type {
	BlobAlreadyExists,
	BlobId,
	BlobNotFound,
	BlobStoreFailed,
} from '@epicenter/blobs';
import type {
	Device,
	DeviceAcquisitionOutcome,
	DeviceIdentifier,
} from '@epicenter/recorder';
import type { AccountIdentity } from '@epicenter/principal';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

/**
 * Recorder failures, named for what went wrong rather than which call surfaced
 * it. A verb-prefixed variant per call site (`InitFailed`, `StartFailed`,
 * `StopFailed`) told a caller only which function it had just invoked, which it
 * already knew; what it could act on is the condition underneath.
 */
export const RecorderError = defineErrors({
	MicrophonePermissionDenied: ({ cause }: { cause?: unknown } = {}) => ({
		message:
			'Microphone access was denied. Please grant microphone permission in your system or browser settings and try again.',
		cause,
	}),
	NoInputDevice: ({ cause }: { cause?: unknown } = {}) => ({
		message:
			"We couldn't find any microphone to record from. Please connect a microphone and try again.",
		cause,
	}),
	/**
	 * Something else already holds the recorder. On desktop there is one host
	 * recorder shared by every window, so this can mean another application
	 * entirely, which is why the message does not assume it was this app.
	 */
	AlreadyRecording: ({ cause }: { cause?: unknown } = {}) => ({
		message:
			'Something is already recording. Stop that recording before starting a new one.',
		cause,
	}),
	/**
	 * The recording being stopped or cancelled is not this caller's to end: it
	 * already finished, it is not the live one, or another window owns it.
	 *
	 * Ordinarily benign. A push-to-talk release that lands after its recording
	 * was already supplanted sees this, and doing nothing is correct. It stays a
	 * typed failure rather than a silent success so a caller that genuinely did
	 * expect a recording can still tell that there wasn't one.
	 */
	NoActiveRecording: ({ cause }: { cause?: unknown } = {}) => ({
		message: 'That recording has already ended.',
		cause,
	}),
	/**
	 * The recorder could not do what was asked for a reason the caller cannot
	 * act on differently: a device that will not open, a stream that will not
	 * build, an IPC failure. The detail travels in `cause`.
	 */
	RecorderFailed: ({ cause }: { cause: unknown }) => ({
		message: `The recorder failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type RecorderError = InferErrors<typeof RecorderError>;

/** The dataset that owns a capture. `null` is the local dataset. */
export type RecordingAccount = AccountIdentity | null;

/**
 * Device selection and dataset ownership supplied when capture starts.
 *
 * This is config resolved from persisted settings (device, encoding).
 *
 * The blob id is deliberately absent: the implementation that owns the capture
 * mints it, and the caller learns it from {@link Recording.audioBlobId}. On
 * desktop that mint happens in Rust, because ownership of the one host recorder
 * is decided there and an id asserted by a caller could not carry it.
 */
export type BaseRecordingParams = {
	selectedDeviceId: DeviceIdentifier | null;
	account: RecordingAccount;
};

/**
 * Browser (MediaRecorder) recording parameters.
 */
export type NavigatorRecordingParams = BaseRecordingParams & {
	bitrateKbps: string;
};

/**
 * Finalized local audio. Every platform has committed bytes before returning,
 * so every field is known: `durationMs` is the host's exact sample count on
 * desktop and the measured capture window in the browser, never absent.
 */
export type RecorderStopResult = {
	audioBlobId: BlobId;
	durationMs: number;
	byteLength: number;
};

export type RecorderStopError =
	| RecorderError
	| BlobAlreadyExists
	| BlobNotFound
	| BlobStoreFailed;

/**
 * Why a recording's capture ended without anyone asking it to.
 *
 * Mirrors the host's `EndedReason`. Each case is one the platform can actually
 * distinguish and the person can act on differently: reconnect the microphone,
 * restore a permission, free some disk, or none of the above.
 */
export type RecordingEndedReason =
	| 'deviceDisconnected'
	| 'permissionRevoked'
	| 'streamFailed'
	| 'storageFailed';

/**
 * A recording, bound to the capture that produced it.
 *
 * `stop` and `cancel` take no id because this object already is the recording;
 * the id it carries is passed to the host underneath. Holding one of these
 * means a recording exists, which is why there is no state to subscribe to: a
 * caller that wants "am I recording" asks whether it holds a Recording, and
 * every ending it caused is the resolution of the call it made.
 *
 * A recording outlives its capture. When the microphone dies the recording is
 * still here, still holding what it captured, and still resolved the same two
 * ways: `stop` publishes, `cancel` discards. Nothing else claims it, expires it,
 * or hands its audio back through another door.
 *
 * The two handlers are the signals a caller genuinely cannot derive on its own:
 * a level that only the capture layer can measure, and an ending nobody asked
 * for. Both are attachable at any time, so a Recording recovered after a reload
 * is as usable as one just started.
 */
export type Recording = {
	readonly audioBlobId: BlobId;
	/** The dataset that owns this capture. */
	readonly account: RecordingAccount;
	/** Which microphone this recording actually opened. */
	readonly device: DeviceAcquisitionOutcome;
	/**
	 * Why this recording's capture already ended, or `null` while it is running.
	 *
	 * A snapshot taken when this object was built, which is the only thing it
	 * usefully can be: a recording that ends later reports it through
	 * {@link Recording.onEnded}. It is non-null only for a recording recovered
	 * from a host that kept capturing while this JS was gone, which is exactly
	 * the case a fresh `start` can never produce and a caller must not miss.
	 */
	readonly endedReason: RecordingEndedReason | null;
	/**
	 * Finalize and publish. The one path that turns a recording into bytes, on
	 * either side of its capture ending: stopping a recording whose microphone
	 * died publishes everything captured before it did.
	 */
	stop(): Promise<Result<RecorderStopResult, RecorderStopError>>;
	/**
	 * Discard the recording. Success carries no payload: a cancel never produces
	 * audio, on any platform.
	 */
	cancel(): Promise<Result<void, RecorderError>>;
	/**
	 * Observe live mic loudness (raw RMS, ~0 silent to ~0.3 loud speech) for as
	 * long as this recording runs. Returns an unsubscribe.
	 *
	 * The browser recorder taps its MediaStream for this. The native recorder
	 * cannot, because the PCM never leaves Rust, so the host measures the level
	 * and emits it to the window that owns the recording.
	 */
	onLevel(handler: (level: number) => void): () => void;
	/**
	 * Observe this recording's capture ending on its own: the microphone was
	 * unplugged, a permission was withdrawn, the capture stream failed. Returns
	 * an unsubscribe.
	 *
	 * Never fires for a stop or a cancel, because those already resolve the call
	 * that requested them. When it does fire the microphone is closed but the
	 * recording is not finished: it still holds everything captured up to that
	 * point, and `stop` still publishes it.
	 *
	 * A signal, not a result: it carries no audio. It is also not the only way
	 * this fires. An ending is a fact the host reports for as long as the
	 * recording is unresolved, not a message it owes anyone, so an implementation
	 * that cannot have observed the moment (its listener was still installing, or
	 * the recording was already ended when it was handed over) reads that state
	 * and announces it here instead. Either way the handler runs exactly once,
	 * and nothing is queued, acknowledged, or replayed to make that true.
	 *
	 * Resolving the recording afterwards is the caller's job. It still holds what
	 * it captured, and on desktop it still holds the host's one recorder slot.
	 */
	onEnded(handler: (reason: RecordingEndedReason) => void): () => void;
};

/**
 * Factory for recordings. The service holds no lifecycle state of its own; a
 * `Recording` owns everything about the capture it represents.
 */
export type RecorderService<RecordingParams extends BaseRecordingParams> = {
	/**
	 * The recording this caller owns, or null.
	 *
	 * Native recordings outlive a JS reload because the host keeps them and the
	 * window label survives; browser recordings cannot, and return null. A pure
	 * read on every platform: it resolves nothing, so asking twice answers twice.
	 *
	 * This is also how a caller finds a recording whose capture ended while it
	 * was gone. The answer carries {@link Recording.endedReason}, and stopping it
	 * publishes what it captured, so there is no separate restore or recovery
	 * call to make.
	 */
	current(
		account: RecordingAccount,
	): Promise<Result<Recording | null, RecorderError>>;

	/**
	 * Enumerate available recording devices, for a picker. Starting does not
	 * need this: `start` resolves and reports its own device.
	 */
	enumerateDevices(): Promise<Result<Device[], RecorderError>>;

	/**
	 * Begin recording. The returned `Recording` carries the minted blob id and
	 * the microphone actually opened, which may differ from the one requested.
	 */
	start(params: RecordingParams): Promise<Result<Recording, RecorderError>>;
};
