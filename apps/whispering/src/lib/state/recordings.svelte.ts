import { fromSubscription } from '@epicenter/svelte';
import { createSubscriber } from 'svelte/reactivity';
import type { WhisperingApp } from '$lib/whispering/app';
import type { Recording } from '$lib/whispering/recording';
import type { WhisperingRecordings } from '$lib/whispering/recordings';

export type { Recording } from '$lib/whispering/recording';

export type Recordings = ReturnType<typeof createRecordings>;

/** Byte arrival does not edit a synchronized row; observe its library owner. */
export function createAttachmentStatus(
	app: Pick<WhisperingApp, 'attachments'>,
) {
	return fromSubscription(app.attachments.subscribe, app.attachments.status);
}

/**
 * Bridges committed recordings-table invalidations into Svelte tracking.
 *
 * Annotated with the domain type rather than inferred: this view restates
 * every member, so a method added to `WhisperingRecordings` and forgotten here
 * is a compile error instead of a surface that silently lost it.
 */
export function createRecordings({
	recordings,
}: Pick<WhisperingApp, 'recordings'>): WhisperingRecordings {
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
		get(id: Recording['id']) {
			invalidate();
			return recordings.get(id);
		},
		create: recordings.create,
		readAudio: recordings.readAudio,
		openAudio: recordings.openAudio,
		patch: recordings.patch,
		delete: recordings.delete,
		audioAvailability: recordings.audioAvailability,
		subscribe: recordings.subscribe,
	};
}
