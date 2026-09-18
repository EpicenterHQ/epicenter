import type { BlobId, BlobStore } from '@epicenter/blobs';
import type { AccountIdentity } from '@epicenter/principal';
import type {
	Device,
	DeviceAcquisitionOutcome,
	DeviceIdentifier,
} from '@epicenter/recorder';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const RecorderError = defineErrors({
	MicrophonePermissionDenied: ({ cause }: { cause?: unknown } = {}) => ({
		message: 'Microphone access was denied.',
		cause,
	}),
	NoInputDevice: ({ cause }: { cause?: unknown } = {}) => ({
		message: 'No microphone is available.',
		cause,
	}),
	AlreadyRecording: ({ cause }: { cause?: unknown } = {}) => ({
		message: 'The recorder already holds a recording.',
		cause,
	}),
	NoActiveRecording: ({ cause }: { cause?: unknown } = {}) => ({
		message: 'This recording is no longer active.',
		cause,
	}),
	StartUnconfirmed: ({ cause }: { cause: unknown }) => ({
		message: `Could not confirm whether recording started: ${extractErrorMessage(cause)}`,
		cause,
	}),
	CaptureLost: ({ cause }: { cause: unknown }) => ({
		message: `Recording ended without recoverable audio: ${extractErrorMessage(cause)}`,
		cause,
	}),
	RecorderFailed: ({ cause }: { cause: unknown }) => ({
		message: `Recording failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type RecorderError = InferErrors<typeof RecorderError>;

export type RecordingParams = {
	selectedDeviceId?: DeviceIdentifier | null;
};

export type RecorderStopResult = {
	blobId: BlobId;
	durationMs: number;
	byteLength: number;
};
export type RecorderStopError = RecorderError;
export type RecordingEndedReason =
	| 'deviceDisconnected'
	| 'permissionRevoked'
	| 'streamFailed'
	| 'storageFailed';

/** One App-owned capture that saves independently of application rows. */
export type Recording = {
	readonly id: string;
	readonly device: DeviceAcquisitionOutcome;
	readonly endedReason: RecordingEndedReason | null;
	/** Stop capture and commit its audio to the app-local blob store. */
	stop(): Promise<Result<RecorderStopResult, RecorderStopError>>;
	/** Discard captured bytes and release capture. */
	cancel(): Promise<Result<void, RecorderError>>;
	onLevel(handler: (level: number) => void): () => void;
	/** Capture failure leaves accepted audio available to stop or cancel. */
	onEnded(handler: (reason: RecordingEndedReason) => void): () => void;
};

export type RecordingService = {
	/** Reconcile this document's live capture; never recover a prior document. */
	current(): Promise<Result<Recording | null, RecorderError>>;
	enumerateDevices(): Promise<Result<Device[], RecorderError>>;
	start(params: RecordingParams): Promise<Result<Recording, RecorderError>>;
};

/** The constructed recorder owns capture and all pending cleanup. */
export type RecordingOwner = {
	value: RecordingService;
	/** Terminal and idempotent; rejects if capture or listener release fails. */
	close(): Promise<void>;
};

export type RecordingOptions = {
	account?: AccountIdentity;
	/** Private immutable writer into the same store as createLocalBlobs({ appId }). */
	write: BlobStore['put'];
	assertUsable?(): void;
};

/** Runtime composition is inert; acquisition happens only on start. */
export type RecordingFactory = (
	appId: string,
	options: RecordingOptions,
) => RecordingOwner;

/** Wire shape pinned against the host's generated bindings by the consumer check. */
export type NativeRecording = {
	/** Native WAV capture reserves this complete key; only successful Stop commits it. */
	audioBlobId: string;
	device:
		| { outcome: 'success'; deviceId: string }
		| {
				outcome: 'fallback';
				deviceId: string;
				reason: 'no-device-selected' | 'preferred-device-unavailable';
		  };
	endedReason: RecordingEndedReason | null;
};
