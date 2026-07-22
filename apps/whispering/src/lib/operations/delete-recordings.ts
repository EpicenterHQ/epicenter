import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { report } from '$lib/report';
import type { Recording } from '$lib/state/recordings.svelte';
import type { WhisperingApp } from '$lib/whispering/app';

/**
 * Confirm and run the app's recording deletion workflow. The record tombstone
 * covers its scalar row, document, and audio obligation as one deletion.
 */
export function deleteRecordingsWithConfirmation(
	app: WhisperingApp,
	toDelete: Recording | Recording[],
	{ onSuccess }: { onSuccess?: () => void } = {},
) {
	const arr = Array.isArray(toDelete) ? toDelete : [toDelete];
	const isSingle = arr.length === 1;
	const noun = isSingle ? 'recording' : 'recordings';

	confirmationDialog.open({
		title: `Delete ${noun}`,
		description: `Are you sure you want to delete ${isSingle ? 'this' : 'these'} ${noun}?`,
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
