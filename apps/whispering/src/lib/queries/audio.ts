import { recordingAudioAvailability } from '../whispering/recordings.js';
import type { Accessor } from '@tanstack/svelte-query';
import { defineKeys } from 'wellcrafted/query';
import type { WhisperingQueryRuntime } from '$lib/queries/client';
import type { Recording } from '../data.js';
import type { WhisperingApp } from '$lib/whispering/app';

export const audioKeys = defineKeys({
	availability: (
		id: Recording['id'],
		audioBlobId: Recording['audioBlobId'],
		audioUrl: Recording['audioUrl'],
	) => ['audio', 'availability', id, audioBlobId, audioUrl] as const,
});

export function createAudioQueries(
	app: WhisperingApp,
	{ defineQuery }: Pick<WhisperingQueryRuntime, 'defineQuery'>,
) {
	return {
		availability: (
			recording: Accessor<Pick<Recording, 'id' | 'audioBlobId' | 'audioUrl'>>,
		) => {
			const current = recording();
			return defineQuery({
				queryKey: audioKeys.availability(
					current.id,
					current.audioBlobId,
					current.audioUrl,
				),
				queryFn: () => recordingAudioAvailability(app, recording().id),
			});
		},
	};
}
