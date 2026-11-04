/**
 * `@epicenter/svelte/tracked`: the one helper every capability's Svelte
 * adapter (`fromAuth`, `fromAi`, `fromClient`, `fromConversation`) is built
 * on (ADR-0765). A capability reads through explicit methods and notifies
 * through one `subscribe(listener)` that returns the unsubscribe; its
 * adapter turns each read into a getter that tracks.
 *
 * Tracking goes through `createSubscriber` from `svelte/reactivity`, not a
 * `$state` shadow: the subscription starts only while something reads
 * inside a tracking context (a template, `$derived`, an effect) and stops
 * when the last reader goes. A read outside tracking, in setup or a
 * handler, is a snapshot that subscribes to nothing. A fix to how adapters
 * subscribe lands here, in every adapter at once.
 *
 * This is not a generic `from(x)`: each adapter names its reads, and one
 * with work of its own (`fromClient` lists a collection while it is read)
 * passes that work as its `subscribe`.
 */
import { createSubscriber } from 'svelte/reactivity';

/** How a capability says it changed: call `listener`, and return the unsubscribe. */
export type Subscribe = (listener: () => void) => () => void;

/**
 * The function a getter calls before it reads: inside a tracking context
 * it subscribes (once, however many getters call it) and reruns the reader
 * when `subscribe`'s listener is called; elsewhere it does nothing.
 */
export function createTracker(subscribe: Subscribe): () => void {
	return createSubscriber((update) => subscribe(update));
}

/** The getters `reads` becomes: each read's answer, under its name. */
export type TrackedReads<TReads extends Record<string, () => unknown>> = {
	readonly [K in keyof TReads]: ReturnType<TReads[K]>;
};

/**
 * An adapter over a capability: each of `reads` becomes a getter of the
 * same name that tracks `subscribe`, beside the members of `rest`, copied
 * as they are (a getter stays a getter).
 *
 * ```ts
 * export const fromAi = (ai: Ai) =>
 * 	trackReads(ai.subscribe, { models: ai.models }, { chat: ai.chat });
 * ```
 */
export function trackReads<
	TReads extends Record<string, () => unknown>,
	TRest extends object = {},
>(
	subscribe: Subscribe,
	reads: TReads,
	rest: TRest = {} as TRest,
): TRest & TrackedReads<TReads> {
	const track = createTracker(subscribe);
	const getters: PropertyDescriptorMap = {};
	for (const [name, read] of Object.entries(reads))
		getters[name] = {
			enumerable: true,
			get() {
				track();
				return read();
			},
		};
	return Object.defineProperties(
		Object.defineProperties({}, Object.getOwnPropertyDescriptors(rest)),
		getters,
	) as TRest & TrackedReads<TReads>;
}
