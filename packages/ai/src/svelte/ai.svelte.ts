import { createSubscriber } from 'svelte/reactivity';
import type { Ai } from '../open-ai.js';

/**
 * Bridge an `openAi(...)` value into Svelte's graph, as `fromAuth` does for
 * an auth client. The core's `models()` becomes a `models` getter that
 * tracks: read in a template, `$derived`, or effect, it subscribes to every
 * endpoint and reruns when one's models change (a local server found or
 * gone, a model downloaded). Read in setup or a handler, it is a snapshot.
 * The subscription is lazy, held only while something reads it, which is
 * also when a probing endpoint looks for its server.
 *
 * `openAi` holds no resources, so an app whose endpoints change merges
 * again and wraps the new value, such as `$derived(fromAi(openAi([...])))`.
 */
export function fromAi(ai: Ai) {
	const subscribe = createSubscriber((update) => ai.subscribe(update));
	return {
		/** Every usable model, in the merged array's order; tracks in Svelte. */
		get models() {
			subscribe();
			return ai.models();
		},
		/** The merged endpoints, in the array's order. */
		endpoints: ai.endpoints(),
		refresh: ai.refresh,
		chat: ai.chat,
		transcribe: ai.transcribe,
		embed: ai.embed,
	};
}
export type ReactiveAi = ReturnType<typeof fromAi>;
