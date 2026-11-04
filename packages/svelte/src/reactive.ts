/**
 * `@epicenter/svelte/reactive`: any capability as Svelte state, under its
 * own names and its own type. A capability reads through methods and
 * accessors and says it changed through one `subscribe(listener)` that
 * returns the unsubscribe (a folder, a collection, a note editor, an auth
 * client, `openAi`); `reactive(capability)` answers the same capability,
 * whose synchronous reads track.
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
 * The rules, applied to whatever the capability holds:
 *
 * - A synchronous read tracks the nearest `subscribe`: a method call whose
 *   answer is not a promise or an async iterable, and an accessor's get.
 *   It tracks through `createSubscriber`, so the subscription starts only
 *   while something reads in a tracking context (a template, `$derived`, an
 *   effect) and stops when the last reader goes; a read elsewhere is a
 *   snapshot.
 * - An async action (a promise or an async iterable) passes through,
 *   untracked.
 * - An object with its own `subscribe`, held or returned (a collection, an
 *   editor), is adapted with that `subscribe`, once: the same object always
 *   answers the same adaptation. Calling the method that returns one does
 *   not track the caller: it made a capability, it read nothing.
 * - A plain object held without one (an editor's `fields`) is adapted with
 *   its holder's `subscribe`; setting one of its accessors sets the
 *   capability's.
 * - What a read answers (arrays, entries, a state object) passes through
 *   untouched: the capability's own values, at their own identity.
 *
 * A read and an action that answers synchronously look alike until called,
 * so a synchronous action called while tracking (`ai.refresh()` in an
 * `$effect`) subscribes the effect to its capability. Call such an action
 * from a handler, or inside `untrack`.
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

/** The descriptor `key` has on `target` or its prototypes. */
function descriptorOf(target: object, key: PropertyKey) {
	for (
		let owner: object | null = target;
		owner !== null;
		owner = Object.getPrototypeOf(owner)
	) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, key);
		if (descriptor !== undefined) return descriptor;
	}
	return undefined;
}

/** `target`, its reads tracking `subscribe`. */
function adapt<T extends object>(target: T, subscribe: Subscribe): T {
	if (adapted.has(target)) return target;
	const known = adaptations.get(target);
	if (known !== undefined) return known as T;
	const track = createSubscriber((update) => subscribe(update));
	/** Each method as adapted, by name, beside the function it adapts. */
	const methods = new Map<PropertyKey, [Function, Function]>();

	/** A read's answer: a capability adapted, anything else tracked and passed through. */
	function answer(value: unknown) {
		if (isObject(value) && subscribes(value)) return own(value);
		track();
		return value;
	}

	function method(key: PropertyKey, fn: Function) {
		const known = methods.get(key);
		if (known?.[0] === fn) return known[1];
		const call = (...args: unknown[]) => {
			const value: unknown = fn.apply(target, args);
			return isAsync(value) ? value : answer(value);
		};
		methods.set(key, [fn, call]);
		return call;
	}

	const proxy = new Proxy(target, {
		get(target, key) {
			const descriptor = descriptorOf(target, key);
			if (descriptor?.get !== undefined)
				return answer(descriptor.get.call(target));
			const value: unknown = descriptor?.value;
			if (key === 'subscribe') return value;
			if (typeof value === 'function') return method(key, value);
			if (isObject(value) && subscribes(value)) return own(value);
			if (isObject(value) && isPlain(value)) return adapt(value, subscribe);
			return value;
		},
		set(target, key, value) {
			return Reflect.set(target, key, value, target);
		},
	});
	adaptations.set(target, proxy);
	adapted.add(proxy);
	return proxy;
}
