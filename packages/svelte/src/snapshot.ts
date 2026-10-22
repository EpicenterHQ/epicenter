/** Svelte observation of an external snapshot, without owning its value or commands. */
import { createSubscriber } from 'svelte/reactivity';

/**
 * Observe a source through a readonly `.current` getter. Construction and
 * untracked reads are passive. Tracking effects share one subscription per
 * view, released after its last reader leaves. Reusing the view avoids
 * replacing subscriptions when its snapshot changes.
 */
export function liveSnapshot<
	TSource extends {
		getSnapshot(): unknown;
		subscribe(listener: () => void): () => void;
	},
>(source: TSource) {
	const track = createSubscriber((update) => {
		// Subscription can answer immediately; the getter reads that value itself.
		let started = false;
		const stop = source.subscribe(() => {
			if (started) update();
		});
		started = true;
		return stop;
	});
	return {
		get current(): ReturnType<TSource['getSnapshot']> {
			track();
			return source.getSnapshot() as ReturnType<TSource['getSnapshot']>;
		},
	};
}
