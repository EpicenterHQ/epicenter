/**
 * Actions: typed queries (reads) and mutations (writes) authored as a flat
 * record keyed by snake_case key. `defineQuery`/`defineMutation` attach metadata
 * to the handler and return it. The action callable IS the handler, so local
 * callers see exactly what the author wrote (sync stays sync, `Result` stays
 * `Result`).
 *
 * One shape: a flat in-memory registry. There is no walker, no segment loop,
 * no path resolver: `Object.entries(actions)` is the iterator, `actions[key]`
 * is the lookup.
 *
 * Boundary callers use `invokeAction`, which Ok-wraps raw values, preserves
 * existing Results, and catches throws as `Err(cause)`. Actions declared in an
 * isomorphic workspace definition are published app commands: hosts may expose
 * them as model-visible tools and direct-invocation targets.
 *
 * @module
 */

import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import {
	type AnyTaggedError,
	defineErrors,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, isResult, Ok, type Result } from 'wellcrafted/result';

// ════════════════════════════════════════════════════════════════════════════
// ACTION DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * The handler function type, conditional on whether input is provided.
 *
 * Uses variadic tuple args instead of conditional function signatures so that
 * `any` distributes over both branches giving `[input: any] | []`, which
 * correctly allows calling with 0 arguments for no-input actions when the type
 * flows through `Action` with wildcard parameters.
 *
 * Parameterized on `R` (the handler's actual return type) rather than splitting
 * `TOutput`/`TError`: keeps the action's callable signature exactly equal to
 * the handler's, so passthrough preserves precision (no widening to a
 * `T | Result<T, E> | Promise<...>` union).
 */
type ActionHandler<
	TInput extends TSchema | undefined = TSchema | undefined,
	R = unknown,
> = (...args: TInput extends TSchema ? [input: Static<TInput>] : []) => R;

/**
 * Configuration for defining an action (query or mutation).
 */
type ActionConfig<TInput extends TSchema | undefined, R> = {
	/** Short, human-readable display name for UI surfaces (e.g. 'Close Tabs'). Optional; the action key is used when omitted. */
	title?: string;
	description?: string;
	input?: TInput;
	handler: ActionHandler<TInput, R>;
};

/**
 * Compile-time error surfaced when a handler returns a bare wellcrafted tagged
 * error instead of wrapping it. The trailing zero-width space, as with
 * {@link InvalidActionKey}, keeps the message a clean sentence in tooltips.
 */
type BareTaggedErrorReturn =
	"Return Err(...) or a defineErrors variant, not a bare tagged error: invokeAction Ok-wraps a non-Result return, so a bare '{ name, message }' would read as success.​";

/**
 * The footgun guard. `invokeAction` Ok-wraps any non-`Result` handler return, so
 * returning a bare tagged error (`{ name, message }`, e.g. `return error` after
 * destructuring a `Result`) would be read as a SUCCESS. This rejects that at the
 * handler: it inspects the awaited return (so `async` handlers are covered) and,
 * if any union member is a bare tagged error, collapses the return to a branded
 * message the handler cannot satisfy. A `defineErrors` variant returns `Err<...>`
 * (a `Result`, `{ data, error }`), which is NOT a bare tagged error, so it passes
 * untouched; only an unwrapped error trips it. A genuine `{ name, message }`
 * success is still expressible, explicitly, via `Ok(...)`.
 */
type RejectBareError<R> = [Extract<Awaited<R>, AnyTaggedError>] extends [never]
	? R
	: BareTaggedErrorReturn;

/** {@link ActionConfig} with the bare-tagged-error return guard on `handler`. */
type GuardedActionConfig<TInput extends TSchema | undefined, R> = ActionConfig<
	TInput,
	R
> & { handler: ActionHandler<TInput, RejectBareError<R>> };

type ActionType = 'query' | 'mutation';

/**
 * Metadata properties attached to a callable action.
 *
 * `input` (a live `TSchema`) is present whenever the action defines one.
 * Action discovery returns this shape directly. There is no separate
 * wire form.
 */
export type ActionMeta<
	TInput extends TSchema | undefined = TSchema | undefined,
	TType extends ActionType = ActionType,
> = {
	type: TType;
	/** Short, human-readable display name for UI surfaces (e.g. 'Close Tabs'). Optional; the action key is used when omitted. */
	title?: string;
	description?: string;
	input?: TInput;
};

/**
 * A query or mutation action definition. Callable function with metadata
 * properties attached. Queries are idempotent reads; mutations write. The
 * `type` discriminant lives on the value, so the type stays a single union
 * rather than three named aliases. The local callable shape IS the handler's
 * signature (sync stays sync, raw stays raw); boundary adapters normalize
 * responses through {@link invokeAction}.
 */
export type Action<
	TInput extends TSchema | undefined = TSchema | undefined,
	R = unknown,
	TType extends ActionType = ActionType,
> = ActionHandler<TInput, R> & ActionMeta<TInput, TType>;

/**
 * Flat snake_case key to `Action` map. The single shape for an in-process
 * action surface: keys are the local address and AI tool name. Author with
 * `defineActions({...})` so the helper enforces the key
 * shape at compile time and at construction; consumers iterate with
 * `Object.entries` or index by string.
 */
export type ActionRegistry = Record<string, Action>;

// ════════════════════════════════════════════════════════════════════════════
// KEY VALIDATION (compile-time + runtime)
// ════════════════════════════════════════════════════════════════════════════

type Lower =
	| 'a'
	| 'b'
	| 'c'
	| 'd'
	| 'e'
	| 'f'
	| 'g'
	| 'h'
	| 'i'
	| 'j'
	| 'k'
	| 'l'
	| 'm'
	| 'n'
	| 'o'
	| 'p'
	| 'q'
	| 'r'
	| 's'
	| 't'
	| 'u'
	| 'v'
	| 'w'
	| 'x'
	| 'y'
	| 'z';
type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type WordChar = Lower | Digit | '_';

/** Recursive tail check: every remaining char must be `[a-z0-9_]`. */
type IsActionKeyTail<S extends string> = S extends ''
	? true
	: S extends `${WordChar}${infer Rest}`
		? IsActionKeyTail<Rest>
		: false;

/**
 * `true` iff `S` matches `^[a-z][a-z0-9_]*$` at the type level. Length is
 * not checked here; the regex catches >64 at runtime. Verified empirically:
 * `arkregex` falls back to `string` for `[a-z]`-class patterns, so we
 * hand-write the template literal walk.
 */
type IsSnakeCaseKey<S extends string> = S extends `${Lower}${infer Rest}`
	? IsActionKeyTail<Rest> extends true
		? true
		: false
	: false;

/**
 * Branded type-level error returned from `ValidatedKey<S>` when `S` is not
 * a valid snake_case action key.
 *
 * The trailing `​` (Unicode zero-width space) makes this literal
 * structurally distinct from any plain string a user could type. TypeScript
 * renders the message in IDE error tooltips without showing the invisible
 * character, so the developer sees a clean English sentence:
 *
 *     Type 'Action' is not assignable to type
 *     'Invalid action key "tabs.close", must be snake_case ASCII matching /^[a-z][a-z0-9_]*$/'.
 *
 * Same pattern `@ark/util`'s internal `ErrorMessage<M>` uses. Inlined here
 * because that helper is not part of `arktype`'s public surface.
 */
type InvalidActionKey<S extends string> =
	`Invalid action key "${S}", must be snake_case ASCII matching /^[a-z][a-z0-9_]*$/​`;

/**
 * Regex enforcing `^[a-z][a-z0-9_]{0,63}$` at runtime. Used by
 * `defineActions` for the authoring boundary check and by tests that pin the
 * runtime grammar.
 */
export const ACTION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Author an `ActionRegistry` with compile-time + runtime key validation.
 *
 * Compile time: each key is checked against the snake_case template-literal
 * type `IsSnakeCaseKey<K>`. A bad key (`'tabs.close'`, `'TabsClose'`,
 * `'0tab'`, `'_x'`) gets typed to `InvalidActionKey<K>` (a branded error
 * string) at that property, so the `Action` value the author wrote fails
 * to assign and TypeScript surfaces the error message at the edit site.
 *
 * Runtime: each key is checked against `ACTION_KEY_PATTERN` so dynamic
 * builders (`Object.fromEntries(...)`) and `as ActionRegistry` casts that
 * bypass the type still fail fast at construction.
 *
 * @example
 * ```ts
 * const actions = defineActions({
 *   entries_create: defineMutation({ ... }),
 *   entries_update: defineMutation({ ... }),
 * });
 * ```
 */
export function defineActions<T extends ActionRegistry>(
	actions: {
		[K in keyof T & string]: IsSnakeCaseKey<K> extends true
			? T[K]
			: InvalidActionKey<K>;
	},
): T {
	for (const key of Object.keys(actions)) {
		if (!ACTION_KEY_PATTERN.test(key)) {
			throw new Error(
				`Invalid action key "${key}". Must match ${ACTION_KEY_PATTERN.source} (snake_case ASCII, starting with a letter, max 64 chars).`,
			);
		}
	}
	return actions as T;
}

/**
 * Define a query (read operation) with full type inference.
 *
 * Returns the handler with metadata attached. The action callable IS the
 * handler. Local callers see whatever the handler returns (sync if sync,
 * raw if raw, `Result` if explicit). Boundary callers can normalize the
 * response with {@link invokeAction}.
 */
/** No input. `TInput` is explicitly `undefined`. */
export function defineQuery<R>(
	config: GuardedActionConfig<undefined, R>,
): Action<undefined, R, 'query'>;
/** With input. `TInput` inferred from the schema. */
export function defineQuery<TInput extends TSchema, R>(
	config: GuardedActionConfig<TInput, R>,
): Action<TInput, R, 'query'>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineQuery({ handler, ...rest }: any): Action {
	return Object.assign(handler, { type: 'query' as const, ...rest });
}

/**
 * Define a mutation (write operation) with full type inference.
 *
 * Returns the handler with metadata attached. The action callable IS the
 * handler. Local callers see whatever the handler returns; boundary adapters
 * can normalize responses with {@link invokeAction}.
 */
/** No input. `TInput` is explicitly `undefined`. */
export function defineMutation<R>(
	config: GuardedActionConfig<undefined, R>,
): Action<undefined, R, 'mutation'>;
/** With input. `TInput` inferred from the schema. */
export function defineMutation<TInput extends TSchema, R>(
	config: GuardedActionConfig<TInput, R>,
): Action<TInput, R, 'mutation'>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineMutation({ handler, ...rest }: any): Action {
	return Object.assign(handler, { type: 'mutation' as const, ...rest });
}

/**
 * Raised by {@link invokeAction} when the supplied input fails the action's
 * declared `input` schema. This is the one place the schema is enforced at
 * runtime: a value that reaches a handler has already matched the contract the
 * action published. An app-specific CLI or tool adapter can map it to a usage
 * error (bad input, not a handler crash).
 */
export const ActionInputError = defineErrors({
	InvalidInput: ({
		errors,
	}: {
		errors: { path: string; message: string }[];
	}) => ({
		message: `Invalid action input: ${errors
			.map((e) => `${e.path || '(root)'} ${e.message}`)
			.join('; ')}`,
		errors,
	}),
});
export type ActionInputError = InferErrors<typeof ActionInputError>;

/**
 * Narrows an `invokeAction` error to a declared-schema validation failure.
 *
 * The error channel of `invokeAction` is `unknown` (a handler can throw
 * anything), so a boundary that special-cases the validation failure needs a
 * type guard to reach `.message` safely. This is the sanctioned single-variant
 * guard, not a total fold: callers special-case `InvalidInput`, every other
 * error flows through unchanged.
 */
export function isActionInputError(error: unknown): error is ActionInputError {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { name?: unknown }).name === 'InvalidInput'
	);
}

/**
 * Invoke an action when the caller does not statically know the handler
 * return shape.
 *
 * When the action declares an `input` schema, the supplied input is validated
 * against it first; a mismatch returns `Err(ActionInputError.InvalidInput)`
 * without ever calling the handler, so the published schema is load-bearing at
 * the trust boundary rather than discovery-only metadata.
 *
 * Otherwise: raw values get `Ok`-wrapped, existing `Result`s pass through, and
 * thrown errors become `Err(cause)` with the raw thrown value under `.error`.
 * Boundary adapters decide how to present that `Err`; callers in-process see
 * whatever the handler actually threw or returned.
 *
 * @example
 * ```ts
 * const result = await invokeAction<{ closedCount: number }>(
 *   workspace.actions.tabs_close,
 *   { tabIds: [1, 2] },
 * );
 * if (result.error) { ... }
 * console.log(result.data.closedCount);
 * ```
 */
export async function invokeAction<T = unknown>(
	action: Action,
	input: unknown | undefined,
): Promise<Result<T, unknown>> {
	if (action.input !== undefined && !Value.Check(action.input, input)) {
		const errors = [...Value.Errors(action.input, input)].map((e) => ({
			path: e.instancePath.replace(/^\//, ''),
			message: e.message,
		}));
		return ActionInputError.InvalidInput({ errors });
	}
	try {
		const ret =
			action.input !== undefined
				? await (action as (i: unknown) => unknown)(input)
				: await (action as () => unknown)();
		return (isResult(ret) ? ret : Ok(ret)) as Result<T, unknown>;
	} catch (cause) {
		return Err(cause);
	}
}
