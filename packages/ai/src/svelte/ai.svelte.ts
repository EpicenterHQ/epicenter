import { createSubscriber } from 'svelte/reactivity';
import type { Ai } from '../open-ai.js';

/**
 * Bridge an `openAi(...)` value into Svelte's graph, as `fromAuth` does for
 * an auth client. The core's reads become getters that track: read in a
 * template, `$derived`, or effect, `models`, `endpoints` and `custom`
 * subscribe to the merge and rerun when it changes (a local server found or
 * gone, a model downloaded, a connection added, a sign-in). Read in setup
 * or a handler, each is a snapshot. The subscription is lazy, held only
 * while something reads, which is also when a probing endpoint looks for
 * its server.
 *
 * An app makes its `openAi` once and wraps it once.
 */
export function fromAi(ai: Ai) {
	const subscribe = createSubscriber((update) => ai.subscribe(update));
	return {
		/** Every usable model, in the merged array's order; tracks in Svelte. */
		get models() {
			subscribe();
			return ai.models();
		},
		/** The endpoints merged now, in the array's order; tracks in Svelte. */
		get endpoints() {
			subscribe();
			return ai.endpoints();
		},
		/** The person's connected endpoints, to add, edit and remove one; tracks in Svelte. */
		get custom() {
			subscribe();
			return ai.custom();
		},
		refresh: ai.refresh,
		chat: ai.chat,
		transcribe: ai.transcribe,
		embed: ai.embed,
	};
}
export type ReactiveAi = ReturnType<typeof fromAi>;
