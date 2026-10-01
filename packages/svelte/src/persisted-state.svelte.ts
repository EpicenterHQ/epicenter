import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { trySync } from 'wellcrafted/result';

// ── Error types ──────────────────────────────────────────────────────────────

export const PersistedError = defineErrors({
	JsonParseFailed: ({
		key,
		raw,
		cause,
	}: {
		key: string;
		raw: string;
		cause: unknown;
	}) => ({
		message: `Failed to parse stored value for "${key}": ${extractErrorMessage(cause)}`,
		key,
		raw,
		cause,
	}),
	SchemaValidationFailed: ({
		key,
		value,
		issues,
	}: {
		key: string;
		value: unknown;
		issues: ReadonlyArray<StandardSchemaV1.Issue>;
	}) => ({
		message: `Schema validation failed for stored value at "${key}"`,
		key,
		value,
		issues,
	}),
});
export type PersistedError = InferErrors<typeof PersistedError>;

// ── createPersistedState ─────────────────────────────────────────────────────

type PersistedStateOptions<TSchema extends StandardSchemaV1> = {
	/** The localStorage (or sessionStorage) key. */
	key: string;
	/** Schema used to validate values read from storage. */
	schema: TSchema;
	/**
	 * Fallback value used when storage is empty or validation fails.
	 * Also used as the initial value on first visit.
	 */
	defaultValue: NoInfer<StandardSchemaV1.InferOutput<TSchema>>;
	/**
	 * Called when a value read from storage fails to parse or validate.
	 * Fire-and-forget. `defaultValue` is used as the fallback regardless.
	 */
	onError?: (error: PersistedError) => void;
	/**
	 * Called when writing to storage fails (e.g., quota exceeded).
	 */
	onUpdateError?: (error: unknown) => void;
};

/**
 * Create reactive persisted state backed by Web Storage with schema validation.
 *
 * Returns an object with a `.current` accessor (following Svelte 5 / runed conventions)
 * Values are validated against a StandardSchemaV1 schema on every read from storage.
 * Cross-tab sync via `storage` event, same-tab sync via `focus` event.
 *
 * @example
 * ```ts
 * import { createPersistedState } from '@epicenter/svelte';
 * import { type } from 'arktype';
 *
 * const theme = createPersistedState({
 *   key: 'app-theme',
 *   schema: type("'light' | 'dark'"),
 *   defaultValue: 'dark',
 * });
 *
 * theme.current;           // 'dark' (reactive)
 * theme.current = 'light';  // persists to localStorage
 *
 * // Imperative read (sync: localStorage is immediate):
 * const value = theme.get();
 * ```
 */
export function createPersistedState<TSchema extends StandardSchemaV1>({
	key,
	schema,
	defaultValue,
	onError,
	onUpdateError,
}: PersistedStateOptions<TSchema>) {
	function parseRawValue(raw: string | null) {
		if (raw === null) return defaultValue;

		const { data: parsed, error: jsonError } = trySync({
			try: () => JSON.parse(raw) as unknown,
			catch: (cause) => PersistedError.JsonParseFailed({ key, raw, cause }),
		});
		if (jsonError) {
			onError?.(jsonError);
			return defaultValue;
		}

		const result = schema['~standard'].validate(parsed);
		if (result instanceof Promise) {
			onError?.(
				PersistedError.SchemaValidationFailed({
					key,
					value: parsed,
					issues: [
						{
							message:
								'Schema returned async result during synchronous validation',
						},
					],
				}).error,
			);
			return defaultValue;
		}

		if (result.issues) {
			onError?.(
				PersistedError.SchemaValidationFailed({
					key,
					value: parsed,
					issues: result.issues,
				}).error,
			);
			return defaultValue;
		}

		return result.value as StandardSchemaV1.InferOutput<TSchema>;
	}

	function readFromStorage() {
		return parseRawValue(window.localStorage.getItem(key));
	}

	// `$state.raw`, not `$state`: this store is replace-only. The single writer is
	// `setValue`, which always assigns a whole new value (`value = nextValue`), and
	// the `.current` setter routes through `setAndPersist`, so nothing ever mutates a
	// field in place. A deep proxy would therefore cost proxying on every persisted
	// array/object for reactivity we never use. `$state.raw` also keeps the value
	// identity stable (the getter returns the exact reference set, which a JSON store
	// wants) and makes the `Object.is` dedup in `setValue` compare real references. It
	// stores by reference and does not freeze, so an accidental `store.current.foo = x`
	// mutates the in-memory object without triggering reactivity or persistence (the
	// missing UI update surfaces the mistake, and the next storage re-parse overwrites
	// it), rather than the `$state` trap where the proxy updates the UI yet the write
	// is never persisted (silent data loss).
	let value = $state.raw(readFromStorage());
	let disposed = false;
	const listeners = new Set<
		(value: StandardSchemaV1.InferOutput<TSchema>) => void
	>();

	function setValue(nextValue: StandardSchemaV1.InferOutput<TSchema>) {
		if (disposed) return;
		if (Object.is(value, nextValue)) return;
		value = nextValue;
		for (const listener of listeners) {
			listener(nextValue);
		}
	}

	function setAndPersist(nextValue: StandardSchemaV1.InferOutput<TSchema>) {
		if (disposed) return;
		setValue(nextValue);
		try {
			window.localStorage.setItem(key, JSON.stringify(nextValue));
		} catch (error) {
			onUpdateError?.(error);
		}
	}

	// Cross-tab sync: the `storage` event fires when ANOTHER tab writes to
	// localStorage. This is why the backend is hardcoded to localStorage and not a
	// `storage: Storage` option: sessionStorage is per-tab and never fires this
	// event, so a sessionStorage-backed instance's headline feature (cross-tab
	// sync) would silently no-op. Per-tab ephemeral state wants a separate
	// primitive, not a swapped backend on this one.
	const handleStorage = (e: StorageEvent) => {
		if (disposed) return;
		if (e.key !== key) return;
		setValue(parseRawValue(e.newValue));
	};

	const handleFocus = () => {
		if (disposed) return;
		setValue(readFromStorage());
	};

	window.addEventListener('storage', handleStorage);

	// Same-tab sync: catches DevTools edits and writes from other stores.
	window.addEventListener('focus', handleFocus);

	return {
		/**
		 * Reactive value for Svelte template bindings and `$derived` blocks.
		 *
		 * For localStorage-backed stores this is always the real value. localStorage
		 * is synchronous, so `.current` is accurate at import time. Use `.get()`
		 * in imperative code (boot scripts, closures) for API parity with async stores.
		 */
		get current() {
			return value;
		},
		set current(newValue: StandardSchemaV1.InferOutput<TSchema>) {
			setAndPersist(newValue);
		},
		/**
		 * Authoritative read: returns the current value synchronously.
		 *
		 * localStorage is synchronous, so this is always the real value.
		 * Use this in imperative code (boot scripts, closures, event handlers)
		 * where you want to be explicit about reading the persisted value.
		 *
		 * @example
		 * ```typescript
		 * const cached = session.get();
		 * if (cached) {
		 *   console.log('Cached session:', cached.token);
		 * }
		 * ```
		 */
		get(): StandardSchemaV1.InferOutput<TSchema> {
			return value;
		},
		/**
		 * Method-form setter for `{ get, set, watch }` consumers. Equivalent to
		 * assigning `.current`: both set the reactive value and persist.
		 */
		set: setAndPersist,
		watch(listener: (value: StandardSchemaV1.InferOutput<TSchema>) => void) {
			if (disposed) return () => {};
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			window.removeEventListener('storage', handleStorage);
			window.removeEventListener('focus', handleFocus);
			listeners.clear();
		},
	};
}
