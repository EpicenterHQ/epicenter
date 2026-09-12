import type { AppBlobs } from '@epicenter/app';
import type {
	BlobId,
	BlobNotFound,
	BlobRemote,
	BlobRemoteFailed,
	BlobStoreFailed,
	RemoteBlobNotFound,
	RemoteNotConfigured,
} from '@epicenter/blobs';
import { InstantString } from '@epicenter/data/field';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { Recording } from './recording.js';

/**
 * The composed blob capability an environment supplies to the app, built once
 * per session for one account: the local bytes are that account's and nobody
 * else's (ADR-0349), so nothing here exists before a replica is open.
 *
 * `remote` is read at call time so its one owner (the platform blobs module)
 * keeps folding auth into availability. `sources` hands out playback URLs over
 * the same local bytes.
 */
export type RecordingAudioAvailability =
	| 'local-only'
	| 'local-and-remote'
	| 'remote-only'
	| 'unavailable';

export const RecordingAudioError = defineErrors({
	RecordingNotFound: ({ recordingId }: { recordingId: Recording['id'] }) => ({
		message: 'This recording no longer exists.',
		recordingId,
	}),
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

/** The per-recording blob state every audio workflow operates on. */
type AudioState = Pick<Recording, 'id' | 'audioBlobId' | 'uploadedAt'>;

/**
 * The app policy over canonical local bytes and an optional remote copy.
 * `uploadedAt` is blob-state metadata: these workflows are its only writer,
 * through `updateUploadedAt`, and every marker change happens strictly after
 * the blob operation it records has succeeded.
 */
export function createRecordingAudio({
	blobs,
	updateUploadedAt,
}: {
	blobs: AppBlobs;
	updateUploadedAt(
		id: Recording['id'],
		uploadedAt: Recording['uploadedAt'],
	): Promise<{ error: unknown | null }>;
}) {
	function normalizeRemoteError(
		recording: AudioState,
		error:
			| BlobNotFound
			| BlobStoreFailed
			| BlobRemoteFailed
			| RemoteNotConfigured
			| RecordingAudioError,
	): BlobNotFound | BlobStoreFailed | BlobRemoteFailed | RecordingAudioError {
		return (error as { name?: string }).name === 'RemoteNotConfigured'
			? RecordingAudioError.RemoteUnavailable({ recordingId: recording.id })
					.error
			: (error as
					| BlobNotFound
					| BlobStoreFailed
					| BlobRemoteFailed
					| RecordingAudioError);
	}

	async function setUploadedAt(
		recording: AudioState,
		uploadedAt: Recording['uploadedAt'],
	): Promise<Result<void, RecordingAudioError>> {
		const { data: update, error: thrownError } = await tryAsync({
			try: () => updateUploadedAt(recording.id, uploadedAt),
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

	return {
		/** Derive storage availability from local bytes and the last successful upload. */
		async availability(
			recording: AudioState,
		): Promise<Result<RecordingAudioAvailability, BlobStoreFailed>> {
			const { error } = await blobs.stat(recording.audioBlobId);
			if (error === null) {
				return Ok(
					recording.uploadedAt === null ? 'local-only' : 'local-and-remote',
				);
			}
			if (error.name === 'BlobNotFound') {
				return Ok(
					recording.uploadedAt === null ? 'unavailable' : 'remote-only',
				);
			}
			return Err(error);
		},

		/** Copy one local recording to the online remote and then record success. */
		async upload(
			recording: AudioState,
		): Promise<
			Result<
				void,
				BlobNotFound | BlobStoreFailed | BlobRemoteFailed | RecordingAudioError
			>
		> {
			if (recording.uploadedAt !== null) return Ok(undefined);
			const remote = blobs.remote;

			const { error: uploadError } = await remote.upload(recording.audioBlobId);
			if (uploadError !== null)
				return Err(normalizeRemoteError(recording, uploadError));
			const markerResult = await setUploadedAt(recording, InstantString.now());
			if (markerResult.error === null) return markerResult;

			const { error: purgeError } = await remote.purge(recording.audioBlobId);
			if (purgeError === null) return markerResult;
			if ((purgeError as { name?: string }).name === 'RemoteNotConfigured')
				return markerResult;
			return RecordingAudioError.UploadCompensationFailed({
				recordingId: recording.id,
				updateError: markerResult.error,
				purgeError,
			});
		},

		/** Copy an explicitly uploaded recording back into the local store. */
		async download(
			recording: AudioState,
		): Promise<
			Result<
				void,
				| RemoteBlobNotFound
				| BlobStoreFailed
				| BlobRemoteFailed
				| RecordingAudioError
				| RecordingAudioError
			>
		> {
			if (recording.uploadedAt === null) {
				return RecordingAudioError.RemoteAudioUnavailable({
					recordingId: recording.id,
				});
			}
			const remote = blobs.remote;
			const result = await remote.download(recording.audioBlobId);
			if (result.error?.name !== 'RemoteBlobNotFound') {
				if (result.error === null) return result;
				return Err(
					normalizeRemoteError(recording, result.error),
				) as unknown as Result<
					void,
					| RemoteBlobNotFound
					| BlobStoreFailed
					| BlobRemoteFailed
					| RecordingAudioError
				>;
			}

			// A remote 404 proves the historical marker stale. Repair the row so the
			// UI does not keep advertising a downloadable copy that no longer exists.
			const markerResult = await setUploadedAt(recording, null);
			return markerResult.error === null
				? (result as unknown as Result<
						void,
						| RemoteBlobNotFound
						| BlobStoreFailed
						| BlobRemoteFailed
						| RecordingAudioError
					>)
				: markerResult;
		},

		/** Remove device bytes only after an online copy has succeeded. */
		async removeLocal(
			recording: AudioState,
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
			const remote = blobs.remote;

			// `uploadedAt` is historical bookkeeping, not proof that the remote
			// object still exists. Re-uploading is idempotent and proves a durable
			// copy exists immediately before this operation destroys the local one.
			const { error: uploadError } = await remote.upload(recording.audioBlobId);
			if (uploadError !== null)
				return Err(normalizeRemoteError(recording, uploadError));
			return blobs.removeLocal(recording.audioBlobId);
		},

		/**
		 * Purge the online copy before clearing its marker.
		 *
		 * `uploadedAt` records the last successful upload, not a transactional
		 * proof that the remote still exists. If the local row write fails after a
		 * successful purge, a later download can therefore return the expected
		 * `RemoteBlobNotFound` result and the user may retry deletion.
		 */
		async purge(
			recording: AudioState,
		): Promise<Result<void, BlobRemoteFailed | RecordingAudioError>> {
			if (recording.uploadedAt === null) return Ok(undefined);
			const remote = blobs.remote;

			const { error: purgeError } = await remote.purge(recording.audioBlobId);
			if (purgeError !== null)
				return Err(normalizeRemoteError(recording, purgeError)) as Result<
					void,
					BlobRemoteFailed | RecordingAudioError
				>;
			return setUploadedAt(recording, null);
		},
	};
}
