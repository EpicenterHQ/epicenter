import type { Accessor } from '@tanstack/svelte-query';
import { defineKeys } from 'wellcrafted/query';
import type { WhisperingQueryRuntime } from '$lib/queries/client';
import type { Recording } from '$lib/state/recordings.svelte';
import { createAttachmentStatus } from '$lib/state/recordings.svelte';
import type { WhisperingApp } from '$lib/whispering/app';

export const audioKeys = defineKeys({
	availability: (
		id: Recording['id'],
		audio: Recording['audio'],
		audioBlobId: Recording['audioBlobId'],
		uploadedAt: Recording['uploadedAt'],
		presence = 'unknown',
	) =>
		[
			'audio',
			'availability',
			id,
			audio,
			audioBlobId,
			uploadedAt,
			presence,
		] as const,
});

export function createAudioQueries(
	app: WhisperingApp,
	{ defineQuery }: Pick<WhisperingQueryRuntime, 'defineQuery'>,
) {
	const status = createAttachmentStatus(app);
	return {
		availability: (
			recording: Accessor<
				Pick<Recording, 'id' | 'audio' | 'audioBlobId' | 'uploadedAt'>
			>,
		) => {
			const current = recording();
			return defineQuery({
				queryKey: audioKeys.availability(
					current.id,
					current.audio,
					current.audioBlobId,
					current.uploadedAt,
					status.current.items.find(
						(item) =>
							item.tableName === 'recordings' && item.rowId === current.id,
					)?.presence,
				),
				queryFn: () => app.recordings.audioAvailability(recording().id),
			});
		},
	};
}
