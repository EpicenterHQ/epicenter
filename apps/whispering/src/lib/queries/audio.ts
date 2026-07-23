import type { Accessor } from '@tanstack/svelte-query';
import { defineErrors } from 'wellcrafted/error';
import { defineKeys } from 'wellcrafted/query';
import { tryAsync } from 'wellcrafted/result';
import type { RecordingId } from '$lib/data';
import type { WhisperingQueryRuntime } from '$lib/queries/client';
import type { WhisperingApp } from '$lib/whispering/app';

export const audioKeys = defineKeys({
	recording: (id: RecordingId) => ['audio', 'recording', id] as const,
});

const AudioQueryError = defineErrors({
	ReadFailed: ({ cause }: { cause: unknown }) => ({
		message: 'Could not read recording audio.',
		cause,
	}),
});

export function createAudioQueries(
	app: WhisperingApp,
	{ defineQuery }: Pick<WhisperingQueryRuntime, 'defineQuery'>,
) {
	return {
		recording: (recordingId: Accessor<RecordingId>) => {
			const id = recordingId();
			return defineQuery({
				queryKey: audioKeys.recording(id),
				queryFn: () =>
					tryAsync({
						try: () => app.recordings.readPlaybackAudio(id),
						catch: (cause) => AudioQueryError.ReadFailed({ cause }),
					}),
			});
		},
	};
}
