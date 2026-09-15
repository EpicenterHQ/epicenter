import type { FinishedFile } from '@epicenter/blobs';
import { type LibraryReplicaIdentity } from '@epicenter/principal';
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

/** The App context captured by this recorder; it does not select a save destination. */
export type RecordingReplica = LibraryReplicaIdentity;

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
		message: `Recording ended without a finished file: ${extractErrorMessage(cause)}`,
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
	file: FinishedFile;
	durationMs: number;
	byteLength: number;
};
export type RecorderStopError = RecorderError;
export type RecordingEndedReason =
	| 'deviceDisconnected'
	| 'permissionRevoked'
	| 'streamFailed'
	| 'storageFailed';

/** One document-owned capture. The workflow separately retains its chosen table. */
export type Recording = {
	readonly id: string;
	readonly replica: RecordingReplica;
	readonly device: DeviceAcquisitionOutcome;
	readonly endedReason: RecordingEndedReason | null;
	/** Stop capture and return a disposable finished file. Library creation saves it. */
	stop(): Promise<Result<RecorderStopResult, RecorderStopError>>;
	/** Discard captured bytes and release capture. */
	cancel(): Promise<Result<void, RecorderError>>;
	onLevel(handler: (level: number) => void): () => void;
	/** Capture failure leaves accepted audio available to stop or cancel. */
	onEnded(handler: (reason: RecordingEndedReason) => void): () => void;
};

export type RecordingService = {
	discard(file: FinishedFile): Promise<Result<void, RecorderError>>;
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
	assertUsable?(): void;
};

/** Runtime composition is inert; acquisition happens only on start. */
export type RecordingFactory = (
	appId: string,
	replica: RecordingReplica,
	options: RecordingOptions,
) => RecordingOwner;

/** Wire shape pinned against the host's generated bindings by the consumer check. */
export type NativeRecording = {
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
