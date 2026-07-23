import { createSubscriber } from 'svelte/reactivity';
import type { Recording } from '$lib/data';
import type { WhisperingApp } from '$lib/whispering/app';

export type { Recording } from '$lib/data';

export type Recordings = ReturnType<typeof createRecordings>;

/** Bridges committed recordings-table invalidations into Svelte tracking. */
export function createRecordings({
	recordings,
}: Pick<WhisperingApp, 'recordings'>) {
	const invalidate = createSubscriber((update) => recordings.subscribe(update));
	return {
		get sorted() {
			invalidate();
			return recordings.sorted;
		},
		get count() {
			invalidate();
			return recordings.count;
		},
		get nonconforming() {
			invalidate();
			return recordings.nonconforming;
		},
		get loadError() {
			invalidate();
			return recordings.loadError;
		},
		get(id: Recording['id']) {
			invalidate();
			return recordings.get(id);
		},
		create: recordings.create,
		update: recordings.update,
		readAudio: recordings.readAudio,
		readPlaybackAudio: recordings.readPlaybackAudio,
		delete: recordings.delete,
		refresh: recordings.refresh,
		subscribe: recordings.subscribe,
	};
}
