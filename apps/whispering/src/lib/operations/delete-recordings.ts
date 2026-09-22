import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { report } from '$lib/report';
import type { RecordingStore } from '$lib/whispering/app';
import type { Recording } from '../data.js';

type RecordingDeletionTarget = Pick<Recording, 'id'>;

/**
 * Delete library rows without claiming that retained audio bytes are reclaimed.
 */
export function deleteRecordingsWithConfirmation(
	store: RecordingStore,
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
			for (const { id } of arr) store.tables.recordings.delete(id);
			report.success({
				title: `Deleted ${noun}!`,
				description: `Your ${noun} ${isSingle ? 'has' : 'have'} been deleted.`,
			});
			onSuccess?.();
		},
	});
}
