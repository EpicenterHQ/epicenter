import type { BlobDestination } from '@epicenter/blobs/native';
import { type LibraryReplicaIdentity } from '@epicenter/principal';
import type { BlobId, BlobStore } from '@epicenter/blobs';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type {
	Device,
	DeviceAcquisitionOutcome,
	DeviceIdentifier,
} from '@epicenter/recorder';

/** The library whose local bytes receive the completed recording. */
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
	audioBlobId: BlobId;
	durationMs: number;
	byteLength: number;
};
export type RecorderStopError =
	| RecorderError
	| NonNullable<Awaited<ReturnType<BlobStore['put']>>['error']>;
export type RecordingEndedReason =
	| 'deviceDisconnected'
	| 'permissionRevoked'
	| 'streamFailed'
	| 'storageFailed';

/** One capture, permanently bound to its original dataset and owner. */
export type Recording = {
	readonly audioBlobId: BlobId;
	readonly replica: RecordingReplica;
	readonly device: DeviceAcquisitionOutcome;
	readonly endedReason: RecordingEndedReason | null;
	/** Stop capture and publish complete local bytes. A session resolves once. */
	stop(): Promise<Result<RecorderStopResult, RecorderStopError>>;
	/** Discard captured bytes and release capture. */
	cancel(): Promise<Result<void, RecorderError>>;
	onLevel(handler: (level: number) => void): () => void;
	/** Capture failure leaves accepted audio available to stop or cancel. */
	onEnded(handler: (reason: RecordingEndedReason) => void): () => void;
};

export type RecordingService = {
	/** Recover this owner's capture, refusing a different destination. */
	current(): Promise<Result<Recording | null, RecorderError>>;
	enumerateDevices(): Promise<Result<Device[], RecorderError>>;
	start(params?: RecordingParams): Promise<Result<Recording, RecorderError>>;
};

/** The constructed recorder owns capture and all pending cleanup. */
export type RecordingOwner = {
	value: RecordingService;
	/** Terminal and idempotent; rejects if capture or listener release fails. */
	close(): Promise<void>;
};

export type RecordingOptions = {
	local: BlobStore;
	assertUsable?(): void;
	canRecover?(): boolean;
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
	destination: BlobDestination;
	device:
		| { outcome: 'success'; deviceId: string }
		| {
				outcome: 'fallback';
				deviceId: string;
				reason: 'no-device-selected' | 'preferred-device-unavailable';
		  };
	endedReason: RecordingEndedReason | null;
};
