import type {
	BlobRemoteFailed,
	BlobStore,
	BlobStoreFailed,
} from '@epicenter/blobs';
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { type Result, tryAsync } from 'wellcrafted/result';
import { report } from '$lib/report';
import { services } from '$lib/services';
import type { Recording } from '$lib/state/recordings.svelte';
import type { WhisperingApplication as WhisperingApp } from '$lib/whispering/application';
import { purgeRecordingAudio, RecordingAudioError } from './recording-audio.js';

export const RecordingDeletionError = defineErrors({
	RowDeleteFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not delete the recording row: ${extractErrorMessage(cause)}`,
		cause,
	}),
	DeletionFailed: ({
		recordingId,
		deletedRecordingIds,
		stage,
		cause,
	}: {
		recordingId: Recording['id'];
		deletedRecordingIds: Recording['id'][];
		stage: 'online-copy' | 'device-copy' | 'recording-row';
		cause: unknown;
	}) => ({
		message:
			deletedRecordingIds.length === 0
				? `Could not delete this recording's ${stage}.`
				: `Deleted ${deletedRecordingIds.length} recording(s), then could not delete the next ${stage}.`,
		recordingId,
		deletedRecordingIds,
		stage,
		cause,
	}),
});
export type RecordingDeletionError = InferErrors<typeof RecordingDeletionError>;

type RecordingDeletionDependencies = {
	local: Pick<BlobStore, 'delete'>;
	canPurgeRemote(): boolean;
	purgeRemote(
		recording: Pick<Recording, 'id' | 'audioBlobId' | 'uploadedAt'>,
	): Promise<Result<void, BlobRemoteFailed | RecordingAudioError>>;
	deleteRow(id: Recording['id']): Promise<void>;
};

function liveDeletionDependencies(
	app: WhisperingApp,
): RecordingDeletionDependencies {
	return {
		local: services.blobs.local,
		canPurgeRemote: () => services.blobs.remote !== null,
		purgeRemote: (recording) => purgeRecordingAudio(app, recording),
		deleteRow: (id) => app.recordings.delete(id),
	};
}

/**
 * Delete recording blobs before their canonical records.
 *
 * Remote availability is preflighted for the whole selection. Each recording
 * then commits sequentially: online copy, device copy, row. If a later item
 * fails, earlier rows are already truthfully gone and the typed error reports
 * the completed prefix.
 */
export async function deleteRecordings(
	app: WhisperingApp,
	toDelete:
		| Pick<Recording, 'id' | 'audioBlobId' | 'uploadedAt'>
		| Array<Pick<Recording, 'id' | 'audioBlobId' | 'uploadedAt'>>,
	dependencies: RecordingDeletionDependencies = liveDeletionDependencies(app),
): Promise<
	Result<
		void,
		| BlobStoreFailed
		| BlobRemoteFailed
		| RecordingAudioError
		| RecordingDeletionError
	>
> {
	const selected = Array.isArray(toDelete) ? toDelete : [toDelete];
	const firstUploaded = selected.find(({ uploadedAt }) => uploadedAt !== null);
	if (firstUploaded && !dependencies.canPurgeRemote()) {
		return RecordingAudioError.RemoteUnavailable({
			recordingId: firstUploaded.id,
		});
	}
	const deletedRecordingIds: Recording['id'][] = [];
	for (const recording of selected) {
		if (recording.uploadedAt !== null) {
			const { error } = await dependencies.purgeRemote(recording);
			if (error !== null) {
				return RecordingDeletionError.DeletionFailed({
					recordingId: recording.id,
					deletedRecordingIds,
					stage: 'online-copy',
					cause: error,
				});
			}
		}
		const { error } = await dependencies.local.delete(recording.audioBlobId);
		if (error !== null) {
			return RecordingDeletionError.DeletionFailed({
				recordingId: recording.id,
				deletedRecordingIds,
				stage: 'device-copy',
				cause: error,
			});
		}
		const { error: rowError } = await tryAsync({
			try: () => dependencies.deleteRow(recording.id),
			catch: (cause) => RecordingDeletionError.RowDeleteFailed({ cause }),
		});
		if (rowError !== null) {
			return RecordingDeletionError.DeletionFailed({
				recordingId: recording.id,
				deletedRecordingIds,
				stage: 'recording-row',
				cause: rowError,
			});
		}
		deletedRecordingIds.push(recording.id);
	}
	return { data: undefined, error: null };
}

export function deleteRecordingsWithConfirmation(
	app: WhisperingApp,
	toDelete: Recording | Recording[],
	{ onSuccess }: { onSuccess?: () => void } = {},
) {
	const arr = Array.isArray(toDelete) ? toDelete : [toDelete];
	const isSingle = arr.length === 1;
	const noun = isSingle ? 'recording' : 'recordings';
	const deletesRemote = arr.some(({ uploadedAt }) => uploadedAt !== null);

	confirmationDialog.open({
		title: deletesRemote ? `Delete ${noun} everywhere` : `Delete ${noun}`,
		description: deletesRemote
			? `This permanently deletes ${isSingle ? 'this recording' : 'these recordings'} from this device and online storage.`
			: `Are you sure you want to delete ${isSingle ? 'this' : 'these'} ${noun}?`,
		confirm: {
			text: deletesRemote ? 'Delete everywhere' : 'Delete',
			variant: 'destructive',
		},
		onConfirm: async () => {
			const { error } = await deleteRecordings(app, arr);
			if (error !== null) {
				report.error({ title: `Failed to delete ${noun}`, cause: error });
				return;
			}
			report.success({
				title: `Deleted ${noun}!`,
				description: `Your ${noun} ${isSingle ? 'has' : 'have'} been deleted.`,
			});
			onSuccess?.();
		},
	});
}
