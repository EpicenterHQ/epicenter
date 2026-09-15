import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { report } from '$lib/report';
import type { Recording } from '$lib/state/recordings.svelte';
import type { WhisperingApp } from '$lib/whispering/app';

type RecordingDeletionTarget = Pick<Recording, 'id'>;

/**
 * Delete library rows without claiming that retained audio bytes are reclaimed.
 */
export function deleteRecordingsWithConfirmation(
	app: WhisperingApp,
	toDelete: RecordingDeletionTarget | RecordingDeletionTarget[],
	{ onSuccess }: { onSuccess?: () => void } = {},
) {
	const arr = Array.isArray(toDelete) ? toDelete : [toDelete];
	const isSingle = arr.length === 1;
	const noun = isSingle ? 'recording' : 'recordings';

	confirmationDialog.open({
		title: `Delete ${noun}`,
		description: `Remove ${isSingle ? 'this recording' : 'these recordings'} from this library? Stored audio files are not erased.`,
		confirm: {
			text: 'Delete',
			variant: 'destructive',
		},
		onConfirm: async () => {
			const { error } = await app.recordings.delete(arr.map(({ id }) => id));
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
