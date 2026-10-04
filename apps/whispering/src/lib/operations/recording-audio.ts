import type {
	BlobNotFound,
	BlobRemote,
	BlobRemoteFailed,
	BlobStore,
	BlobStoreFailed,
	RemoteBlobNotFound,
} from '@epicenter/blobs';
import { InstantString } from '@epicenter/field';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { services } from '$lib/services';
import type { Recording } from '$lib/state/recordings.svelte';
import type { WhisperingApplication as WhisperingApp } from '$lib/whispering/application';

export type RecordingAudioAvailability =
	| 'local-only'
	| 'local-and-remote'
	| 'remote-only'
	| 'unavailable';

export const RecordingAudioError = defineErrors({
	RemoteUnavailable: ({ recordingId }: { recordingId: Recording['id'] }) => ({
		message: 'Online audio storage is not available right now.',
		recordingId,
	}),
	RemoteAudioUnavailable: ({
		recordingId,
	}: {
		recordingId: Recording['id'];
	}) => ({
		message: 'This recording has no known online audio copy.',
		recordingId,
	}),
	RowUpdateFailed: ({
		recordingId,
		cause,
	}: {
		recordingId: Recording['id'];
		cause: unknown;
	}) => ({
		message: `Could not update recording storage metadata: ${extractErrorMessage(cause)}`,
		recordingId,
		cause,
	}),
	UploadCompensationFailed: ({
		recordingId,
		updateError,
		purgeError,
	}: {
		recordingId: Recording['id'];
		updateError: unknown;
		purgeError: unknown;
	}) => ({
		message:
			'Audio uploaded, but its recording could not be updated and the online copy could not be rolled back.',
		recordingId,
		updateError,
		purgeError,
	}),
});
export type RecordingAudioError = InferErrors<typeof RecordingAudioError>;

type RecordingRowUpdate = {
	error: unknown | null;
};

type RecordingAudioDependencies = {
	/**
	 * The composed blob capability. `remote` is read at call time so its one
	 * owner (the platform blobs module) keeps folding auth into availability.
	 */
	blobs: {
		local: Pick<BlobStore, 'delete' | 'stat'>;
		readonly remote: BlobRemote | null;
	};
	updateRecording(
		id: Recording['id'],
		changes: Pick<Recording, 'uploadedAt'>,
	): Promise<RecordingRowUpdate>;
	now(): Exclude<Recording['uploadedAt'], null>;
};

function liveDependencies(app: WhisperingApp): RecordingAudioDependencies {
	return {
		blobs: services.blobs,
		updateRecording: (id, changes) => app.recordings.update(id, changes),
		now: InstantString.now,
	};
}

function requireRemote(
	recording: Pick<Recording, 'id'>,
	dependencies: RecordingAudioDependencies,
): Result<BlobRemote, RecordingAudioError> {
	const remote = dependencies.blobs.remote;
	if (remote === null) {
		return RecordingAudioError.RemoteUnavailable({
			recordingId: recording.id,
		});
	}
	return Ok(remote);
}

async function setUploadedAt(
	recording: Pick<Recording, 'id'>,
	uploadedAt: Recording['uploadedAt'],
	dependencies: RecordingAudioDependencies,
): Promise<Result<void, RecordingAudioError>> {
	const { data: update, error: thrownError } = await tryAsync({
		try: () => dependencies.updateRecording(recording.id, { uploadedAt }),
		catch: (cause) =>
			RecordingAudioError.RowUpdateFailed({
				recordingId: recording.id,
				cause,
			}),
	});
	if (thrownError !== null) return Err(thrownError);
	if (update.error !== null) {
		return RecordingAudioError.RowUpdateFailed({
			recordingId: recording.id,
			cause: update.error,
		});
	}
	return Ok(undefined);
}

/** Derive storage availability from local bytes and the last successful upload. */
export async function getRecordingAudioAvailability(
	recording: Pick<Recording, 'audioBlobId' | 'uploadedAt'>,
	dependencies: Pick<RecordingAudioDependencies, 'blobs'> = {
		blobs: services.blobs,
	},
): Promise<Result<RecordingAudioAvailability, BlobStoreFailed>> {
	const { error } = await dependencies.blobs.local.stat(recording.audioBlobId);
	if (error === null) {
		return Ok(
			recording.uploadedAt === null ? 'local-only' : 'local-and-remote',
		);
	}
	if (error.name === 'BlobNotFound') {
		return Ok(recording.uploadedAt === null ? 'unavailable' : 'remote-only');
	}
	return Err(error);
}

/** Copy one local recording to the online remote and then record success. */
export async function uploadRecordingAudio(
	app: WhisperingApp,
	recording: Pick<Recording, 'id' | 'audioBlobId' | 'uploadedAt'>,
	dependencies: RecordingAudioDependencies = liveDependencies(app),
): Promise<
	Result<
		void,
		BlobNotFound | BlobStoreFailed | BlobRemoteFailed | RecordingAudioError
	>
> {
	if (recording.uploadedAt !== null) return Ok(undefined);
	const { data: remote, error: unavailable } = requireRemote(
		recording,
		dependencies,
	);
	if (unavailable !== null) return Err(unavailable);

	const { error: uploadError } = await remote.upload(recording.audioBlobId);
	if (uploadError !== null) return Err(uploadError);
	const markerResult = await setUploadedAt(
		recording,
		dependencies.now(),
		dependencies,
	);
	if (markerResult.error === null) return markerResult;

	const { error: purgeError } = await remote.purge(recording.audioBlobId);
	if (purgeError === null) return markerResult;
	return RecordingAudioError.UploadCompensationFailed({
		recordingId: recording.id,
		updateError: markerResult.error,
		purgeError,
	});
}

/** Copy an explicitly uploaded recording back into the local store. */
export async function downloadRecordingAudio(
	app: WhisperingApp,
	recording: Pick<Recording, 'id' | 'audioBlobId' | 'uploadedAt'>,
	dependencies: RecordingAudioDependencies = liveDependencies(app),
): Promise<
	Result<
		void,
		| RemoteBlobNotFound
		| BlobStoreFailed
		| BlobRemoteFailed
		| RecordingAudioError
	>
> {
	if (recording.uploadedAt === null) {
		return RecordingAudioError.RemoteAudioUnavailable({
			recordingId: recording.id,
		});
	}
	const { data: remote, error: unavailable } = requireRemote(
		recording,
		dependencies,
	);
	if (unavailable !== null) return Err(unavailable);
	const result = await remote.download(recording.audioBlobId);
	if (result.error?.name !== 'RemoteBlobNotFound') return result;

	// A remote 404 proves the historical marker stale. Repair the row so the UI
	// does not keep advertising a downloadable copy that no longer exists.
	const markerResult = await setUploadedAt(recording, null, dependencies);
	return markerResult.error === null ? result : markerResult;
}

/** Remove device bytes only after an online copy has succeeded. */
export async function removeLocalRecordingAudio(
	app: WhisperingApp,
	recording: Pick<Recording, 'id' | 'audioBlobId' | 'uploadedAt'>,
	dependencies: RecordingAudioDependencies = liveDependencies(app),
): Promise<
	Result<
		void,
		BlobNotFound | BlobStoreFailed | BlobRemoteFailed | RecordingAudioError
	>
> {
	if (recording.uploadedAt === null) {
		return RecordingAudioError.RemoteAudioUnavailable({
			recordingId: recording.id,
		});
	}
	const { data: remote, error: unavailable } = requireRemote(
		recording,
		dependencies,
	);
	if (unavailable !== null) return Err(unavailable);

	// `uploadedAt` is historical bookkeeping, not proof that the remote object
	// still exists. Re-uploading is idempotent and proves a durable copy exists
	// immediately before this operation destroys the local one.
	const { error: uploadError } = await remote.upload(recording.audioBlobId);
	if (uploadError !== null) return Err(uploadError);
	return dependencies.blobs.local.delete(recording.audioBlobId);
}

/**
 * Purge the online copy before clearing its marker.
 *
 * `uploadedAt` records the last successful upload, not a transactional proof
 * that the remote still exists. If the local row write fails after a successful
 * purge, a later download can therefore return the expected
 * `RemoteBlobNotFound` result and the user may retry deletion.
 */
export async function purgeRecordingAudio(
	app: WhisperingApp,
	recording: Pick<Recording, 'id' | 'audioBlobId' | 'uploadedAt'>,
	dependencies: RecordingAudioDependencies = liveDependencies(app),
): Promise<Result<void, BlobRemoteFailed | RecordingAudioError>> {
	if (recording.uploadedAt === null) return Ok(undefined);
	const { data: remote, error: unavailable } = requireRemote(
		recording,
		dependencies,
	);
	if (unavailable !== null) return Err(unavailable);

	const { error: purgeError } = await remote.purge(recording.audioBlobId);
	if (purgeError !== null) return Err(purgeError);
	return setUploadedAt(recording, null, dependencies);
}
