import { createSubscriber } from 'svelte/reactivity';

/** The slice of `KvHandle` the adapter touches: its reads, and one feed. */
export type AdaptableKv = {
	get(key: never): unknown;
	readonly nonconforming: unknown[];
	subscribe(listener: () => void): () => void;
};

const projections = new WeakMap<AdaptableKv, AdaptableKv>();

/** Adapt KV reads without projecting tables from a library the UI does not display. */
export function fromKv<TKv extends AdaptableKv>(kv: TKv): TKv {
	// Read through, unlike a table, and the rule is the same one: hold what is
	// expensive to rebuild. Ten keys and ten validations is not, so there is
	// nothing here to hold, nothing to keep current, and no `keys()` verb the
	// handle would have to grow so this could seed itself.
	const existing = projections.get(kv);
	if (existing) return existing as TKv;
	const subscribe = createSubscriber((update) => kv.subscribe(update));
	// Descriptors for the same reason a table needs them: `nonconforming` is a
	// getter, and a spread would invoke it.
	const reactive = Object.freeze(
		Object.defineProperties(
			{},
			{
				...Object.getOwnPropertyDescriptors(kv),
				get: {
					enumerable: true,
					value: (key: never) => {
						subscribe();
						return kv.get(key);
					},
				},
				nonconforming: {
					enumerable: true,
					get() {
						subscribe();
						return kv.nonconforming;
					},
				},
			},
		),
	) as TKv;
	projections.set(kv, reactive);
	return reactive;
}
