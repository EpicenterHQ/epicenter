import type { Accessor } from '@tanstack/svelte-query';
import { defineKeys } from 'wellcrafted/query';
import type { WhisperingQueryRuntime } from '$lib/queries/client';
import type { WhisperingApp } from '$lib/whispering/app';
import type { Recording } from '../data.js';
import { recordingAudioAvailability } from '../whispering/recordings.js';

export const audioKeys = defineKeys({
	availability: (
		id: Recording['id'],
		audioBlobId: Recording['audioBlobId'],
		remoteAudio: Recording['remoteAudio'],
	) => ['audio', 'availability', id, audioBlobId, remoteAudio] as const,
});

export function createAudioQueries(
	app: WhisperingApp,
	{ defineQuery }: Pick<WhisperingQueryRuntime, 'defineQuery'>,
) {
	return {
		availability: (
			recording: Accessor<
				Pick<Recording, 'id' | 'audioBlobId' | 'remoteAudio'>
			>,
		) => {
			const current = recording();
			return defineQuery({
				queryKey: audioKeys.availability(
					current.id,
					current.audioBlobId,
					current.remoteAudio,
				),
				queryFn: () => recordingAudioAvailability(app, recording().id),
			});
		},
	};
}
