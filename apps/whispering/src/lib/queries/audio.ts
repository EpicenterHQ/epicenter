import type { Accessor } from '@tanstack/svelte-query';
import { defineKeys } from 'wellcrafted/query';
import { getRecordingAudioAvailability } from '$lib/operations/recording-audio';
import type { WhisperingQueryRuntime } from '$lib/queries/client';
import type { Recording } from '$lib/state/recordings.svelte';

export const audioKeys = defineKeys({
	availability: (
		id: Recording['id'],
		audioBlobId: Recording['audioBlobId'],
		uploadedAt: Recording['uploadedAt'],
	) => ['audio', 'availability', id, audioBlobId, uploadedAt] as const,
});

export function createAudioQueries({
	defineQuery,
}: Pick<WhisperingQueryRuntime, 'defineQuery'>) {
	return {
		availability: (
			recording: Accessor<Pick<Recording, 'id' | 'audioBlobId' | 'uploadedAt'>>,
		) => {
			const current = recording();
			return defineQuery({
				queryKey: audioKeys.availability(
					current.id,
					current.audioBlobId,
					current.uploadedAt,
				),
				queryFn: () => getRecordingAudioAvailability(recording()),
			});
		},
	};
}
