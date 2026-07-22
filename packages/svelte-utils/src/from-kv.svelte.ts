import { createSubscriber } from 'svelte/reactivity';
import type { Result } from 'wellcrafted/result';

type ValueLens<TValue> = {
	get(): Promise<Result<TValue | undefined, Error>>;
	set(value: TValue): Promise<void>;
	unset(): Promise<void>;
	subscribe(listener: () => void): () => void;
};

/** Create a reactive value box over one bound Data value lens. */
export function fromKv<TValue>(value: ValueLens<TValue>): {
	current: TValue | undefined;
	readonly loadError: unknown;
	readonly whenReady: Promise<void>;
	refresh(): Promise<void>;
} {
	let current = $state.raw<TValue | undefined>(undefined);
	let loadError = $state.raw<unknown>(null);
	let refreshGeneration = 0;

	async function refresh(): Promise<void> {
		const generation = ++refreshGeneration;
		const result = await value.get();
		if (generation !== refreshGeneration) return;
		if (result.error !== null) {
			loadError = result.error;
			return;
		}
		current = result.data;
		loadError = null;
	}

	const subscribe = createSubscriber((update) =>
		value.subscribe(() => {
			void refresh().then(update, update);
		}),
	);
	const whenReady = refresh();

	return {
		get current() {
			subscribe();
			return current;
		},
		set current(newValue: TValue | undefined) {
			current = newValue;
			const write =
				newValue === undefined ? value.unset() : value.set(newValue);
			void write.catch((cause) => {
				loadError = cause;
				void refresh();
			});
		},
		get loadError() {
			subscribe();
			return loadError;
		},
		whenReady,
		refresh,
	};
}
