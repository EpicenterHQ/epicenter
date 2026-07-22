import type {
	Device,
	DeviceAcquisitionOutcome,
	DeviceIdentifier,
} from '@epicenter/recorder';
import type { Brand } from 'wellcrafted/brand';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

/**
 * Recorder lifecycle state. A plain union: the states are never validated at
 * runtime, only used as compile-time types. Emitted by
 * {@link RecordingSession.subscribe}.
 */
export type RecordingState = 'IDLE' | 'RECORDING';

export const RecorderError = defineErrors({
	EnumerateDevices: ({ cause }: { cause: unknown }) => ({
		message: `Failed to enumerate recording devices: ${extractErrorMessage(cause)}`,
		cause,
	}),
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
	InitFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to initialize the audio recorder: ${extractErrorMessage(cause)}`,
		cause,
	}),
	StartFailed: ({ cause }: { cause: unknown }) => ({
		message: `Unable to start recording: ${extractErrorMessage(cause)}`,
		cause,
	}),
	StopFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to stop recording: ${extractErrorMessage(cause)}`,
		cause,
	}),
	CancelFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to cancel recording: ${extractErrorMessage(cause)}`,
		cause,
	}),
	StreamAcquisition: ({ cause }: { cause: unknown }) => ({
		message: `Failed to acquire recording stream: ${extractErrorMessage(cause)}`,
		cause,
	}),
	GetStateFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to get recorder state: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type RecorderError = InferErrors<typeof RecorderError>;

/**
 * Settings-derived parameters shared across manual recorder implementations.
 *
 * This is config resolved from persisted settings (device, encoding). Live
 * caller callbacks are not config and travel separately in
 * {@link RecordingCallbacks}.
 */
export type BaseRecordingParams = {
	selectedDeviceId: DeviceIdentifier | null;
};

/** Ephemeral identity used only to stop the exact live capture session. */
export type RecordingSessionId = string & Brand<'RecordingSessionId'>;

/**
 * Live callbacks supplied by the caller at the moment of starting, kept
 * separate from the settings-derived params config (a {@link BaseRecordingParams}
 * extension such as {@link NavigatorRecordingParams}) because a callback is not
 * a persisted setting. They are passed alongside the resolved params, never
 * merged into them.
 */
export type RecordingCallbacks = {
	/**
	 * Sink for live mic loudness (raw RMS, ~0 silent to ~0.3 loud speech),
	 * called continuously while recording so the caller can draw a meter.
	 *
	 * The browser recorder taps its MediaStream to drive this. The CPAL recorder
	 * reaches the same meter another way (emitting the level straight to the
	 * overlay window), so its `startRecording` simply does not accept callbacks.
	 */
	onLevel: (level: number) => void;
};

/**
 * Browser (MediaRecorder) recording parameters.
 */
export type NavigatorRecordingParams = BaseRecordingParams & {
	bitrateKbps: string;
};

/**
 * Finalized audio ready for the app to capture under a durable recording id.
 * Native capture stays opaque until the Bun owner adopts its fsynced staging
 * artifact; browser and imported bytes remain ordinary Blobs.
 */
export type FinalizedAudio =
	| { kind: 'bytes'; bytes: Blob }
	| {
			kind: 'native-capture';
			captureId: string;
			byteLength: number;
			/** Clear native pending state only after atomic record admission. */
			acknowledgeAdmission(): Promise<void>;
	  };

/** Refuse an opaque native capture in runtimes that can only admit bytes. */
export function requireFinalizedAudioBytes(audio: FinalizedAudio): Blob {
	if (audio.kind === 'bytes') return audio.bytes;
	throw new Error('Native capture requires the desktop record owner');
}

export type RecorderStopResult = {
	audio: FinalizedAudio;
	durationMs: number | null;
	byteLength: number;
};

export type RecorderStopError = RecorderError;

/**
 * A live recording session returned by the recorder implementation that started it.
 *
 * The `RecordingSession` is the unit of lifecycle: it owns its own teardown and
 * exposes per-session state changes.
 *
 * The `subscribe` handler is invoked synchronously with the current state on
 * subscribe (so callers don't have to mirror "I just started" themselves),
 * then again whenever the session transitions, ending with 'IDLE' on
 * stop/cancel.
 */
export type RecordingSession = {
	readonly id: RecordingSessionId;
	/** True after durable stop until the recording row admits the capture. */
	readonly awaitingAdmission: boolean;
	stop(): Promise<Result<RecorderStopResult, RecorderStopError>>;
	/**
	 * Cancel the in-flight recording and discard it. Success carries no payload
	 * (a live session can only resolve to "cancelled"); the caller's wrapper is
	 * where the `cancelled` vs `no-recording` distinction is made.
	 */
	cancel(): Promise<Result<void, RecorderError>>;
	subscribe(handler: (state: RecordingState) => void): () => void;
};

/**
 * Factory for recording sessions. Services no longer carry mutable
 * start/stop state directly; instead `startRecording` returns a RecordingSession
 * whose methods are bound to the implementation that produced it.
 */
export type RecorderService<RecordingParams extends BaseRecordingParams> = {
	/**
	 * Recover a RecordingSession that may have survived a JS reload.
	 *
	 * Native sessions can outlive a JS reload because the host process keeps the
	 * stream; browser sessions cannot survive a reload and return null.
	 *
	 * Returns the live RecordingSession owned by this implementation, or null if none.
	 */
	resumeActiveSession(): Promise<
		Result<RecordingSession | null, RecorderError>
	>;

	/**
	 * Enumerate available recording devices with their labels and identifiers
	 */
	enumerateDevices(): Promise<Result<Device[], RecorderError>>;

	/**
	 * Start a new recording session, returning the RecordingSession handle along
	 * with the device acquisition outcome. The caller holds the RecordingSession
	 * and uses its `stop`/`cancel`/`subscribe` for the rest of the session.
	 *
	 * `params` is settings-derived config; `callbacks` are the caller's live
	 * sinks. An implementation that satisfies the meter another way (e.g. a
	 * native overlay) may take only `params` and ignore the callbacks.
	 */
	startRecording(
		params: RecordingParams,
		callbacks: RecordingCallbacks,
	): Promise<
		Result<
			{
				session: RecordingSession;
				deviceAcquisition: DeviceAcquisitionOutcome;
			},
			RecorderError
		>
	>;
};
