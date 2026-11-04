/**
 * `@epicenter/svelte/reactive`: any capability as Svelte state, under its
 * own names and its own type. A capability reads through methods and
 * accessors and says it changed through one `subscribe(listener)` that
 * returns the unsubscribe (a folder, a collection, a note editor, an auth
 * client, `openAi`); `reactive(capability)` answers a copy of it, made
 * once, whose reads track.
 *
 * ```ts
 * // src/lib/app.ts
 * export const folder = reactive(openFolder(todos, { site }));
 * ```
 *
 * ```svelte
 * {#each folder.todos.items() as todo (todo.id)}…{/each}
 * ```
 *
 * It reads the capability's shape (ADR-0769). Everything a capability does
 * is one of four verbs, and each answers in its own form: creating answers a
 * capability with its own `subscribe`, reading answers a value at once,
 * acting answers a promise (or an async iterable), and listening answers the
 * unsubscribe. So the rules, applied to each member the capability has, are:
 *
 * - A read tracks the nearest `subscribe`: a method call whose answer is
 *   not a promise or an async iterable, and an accessor's get. It tracks
 *   through `createSubscriber`, so the subscription starts only while
 *   something reads in a tracking context (a template, `$derived`, an
 *   effect) and stops when the last reader goes; a read elsewhere is a
 *   snapshot.
 * - An action passes through, untracked, even when an effect calls it.
 * - An object with its own `subscribe`, held or returned (a collection, an
 *   editor), is adapted with that `subscribe`, once: the same object always
 *   answers the same adaptation. Calling the method that returns one does
 *   not track the caller: it made a capability, it read nothing.
 * - A plain object held without one (an editor's `fields`) is adapted with
 *   its holder's `subscribe`; setting one of its accessors sets the
 *   capability's.
 * - What a read answers (arrays, entries, a state object) passes through
 *   untouched: the capability's own values, at their own identity.
 * - `subscribe` and the symbol-keyed members (`Symbol.dispose`) carry
 *   through as they are: listening, and the language's own protocols.
 *
 * The copy is made from the capability's own members when it is adapted. A
 * capability is a plain object its factory made whole, so nothing is added
 * later for the copy to miss.
 *
 * React reads the same capability without this module:
 * `useSyncExternalStore(folder.todos.subscribe, folder.todos.items)`.
 */
import { createSubscriber } from 'svelte/reactivity';

/** How a capability says it changed: call `listener`, and return the unsubscribe. */
export type Subscribe = (listener: () => void) => () => void;

/** Each object's adaptation, so one object always answers one. */
const adaptations = new WeakMap<object, object>();
/** The adaptations themselves, so adapting one again answers it. */
const adapted = new WeakSet<object>();

/**
 * `capability`, whose synchronous reads track its `subscribe` in Svelte.
 * Make it once, beside the capability (`src/lib/app.ts`), and read it
 * anywhere.
 */
export function reactive<TCapability extends { subscribe: Subscribe }>(
	capability: TCapability,
): TCapability {
	return own(capability);
}

/** `capability` adapted with its own `subscribe`. */
const own = <T extends { subscribe: Subscribe }>(capability: T): T =>
	adapt(capability, (listener) => capability.subscribe(listener));

const isObject = (value: unknown): value is object =>
	typeof value === 'object' && value !== null;

/** Whether `value` holds its own `subscribe`: a capability of its own. */
const subscribes = (value: object): value is { subscribe: Subscribe } =>
	typeof (value as { subscribe?: unknown }).subscribe === 'function';

/** Whether `value` is a plain object: a part of its holder, not data of a class. */
const isPlain = (value: object) => {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
};

/** Whether `value` answers later: a promise, or an async iterable. */
const isAsync = (value: unknown) =>
	isObject(value) &&
	(typeof (value as { then?: unknown }).then === 'function' ||
		typeof (value as { [Symbol.asyncIterator]?: unknown })[
			Symbol.asyncIterator
		] === 'function');

/** A copy of `target` whose reads track `subscribe`, made once. */
function adapt<T extends object>(target: T, subscribe: Subscribe): T {
	if (adapted.has(target)) return target;
	const known = adaptations.get(target);
	if (known !== undefined) return known as T;
	const track = createSubscriber((update) => subscribe(update));

	/** A read's answer: a capability adapted, anything else tracked and passed through. */
	function answer(value: unknown) {
		if (isObject(value) && subscribes(value)) return own(value);
		track();
		return value;
	}

	/** The member `key` holding `value`, as the copy holds it. */
	function member(key: PropertyKey, value: unknown): unknown {
		if (typeof value === 'function') {
			if (key === 'subscribe' || typeof key === 'symbol')
				return value.bind(target);
			return (...args: unknown[]) => {
				const answered: unknown = value.apply(target, args);
				return isAsync(answered) ? answered : answer(answered);
			};
		}
		if (!isObject(value)) return value;
		if (subscribes(value)) return own(value);
		if (isPlain(value)) return adapt(value, subscribe);
		return value;
	}

	const copy = Object.create(Object.getPrototypeOf(target)) as T;
	adaptations.set(target, copy);
	adapted.add(copy);
	for (const key of Reflect.ownKeys(target)) {
		const { get, set, value, enumerable } =
			Object.getOwnPropertyDescriptor(target, key) ?? {};
		Object.defineProperty(
			copy,
			key,
			get || set
				? {
						enumerable,
						get: get && (() => answer(get.call(target))),
						set: set && ((next: unknown) => set.call(target, next)),
					}
				: { enumerable, value: member(key, value) },
		);
	}
	return copy;
}
