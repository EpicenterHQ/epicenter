/**
 * An action: one thing a person, an agent or a page can ask a home to do,
 * with a description and the fields of its input. Every action is written
 * with `defineAction`; nothing is reachable from the command, MCP or a page
 * unless an action exposes it.
 *
 * ```ts
 * const add = defineAction({
 *   description: 'Save a thought, named by the time',
 *   input: { body: field.text() },
 *   run: ({ body }) => notes.create(timeId(), { body }),
 * });
 * ```
 *
 * `run` may take a second argument, `update`, and call it to say where it is
 * while it runs. Annotate it, and every caller's `onUpdate` has that type:
 *
 * ```ts
 * async run({ account }, update: Update<{ copied: number }>) {
 *   for (const copied of await copy(account)) update({ copied });
 *   return Ok(null);
 * }
 * ```
 *
 * An update reports and is never the answer: a caller that does not listen
 * loses nothing. An action is also an async function, so a test awaits it
 * directly; a direct call skips the input check serve makes.
 */

import type { Static, TObject, TSchema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import { isResult } from './call.ts';
import type { PublicError } from './errors.ts';
import {
	defaultIn,
	type Flat,
	type ObjectSchema,
	objectSchema,
} from './field.ts';

/** An action's input as an app writes it: a record of fields. */
export type Input = Record<string, TSchema>;

/**
 * What `run` calls to report while it runs. It returns at once and never
 * throws: what a listener returns is not awaited and what it throws is
 * dropped, so no caller can slow or stop the action.
 */
export type Update<U> = (value: U) => void;

/**
 * An action: a function of its input that carries its description and its
 * input as one JSON Schema object. `U` is what it reports through `update`,
 * `never` for one that only returns.
 */
// biome-ignore lint/suspicious/noExplicitAny: a bare Action is any action, whatever it takes and reports.
export type Action<In = any, Out = unknown, U = any> = ((
	input: In,
	options?: { onUpdate?: (value: U) => unknown },
) => Promise<Awaited<Out>>) & {
	readonly description: string;
	/**
	 * Every field as one JSON Schema object: `required` lists the keys a
	 * caller must give, `[]` when none is, and other keys are refused.
	 * Serve checks a call with it, and MCP and the listing show it.
	 */
	readonly input: ObjectSchema;
};

/** What the action `A` reports while it runs, `never` when it only returns. */
export type ActionUpdate<A> =
	A extends Action<never, unknown, infer U> ? U : never;

/**
 * What an action may return: a value that survives JSON. `undefined`
 * arrives as `null`, and a property that is `undefined` arrives absent.
 */
type Returned =
	| string
	| number
	| boolean
	| null
	| undefined
	| void
	| readonly Returned[]
	| { readonly [key: string]: Returned };

/** What `run` returns: a Result whose data survives JSON. */
type RunResult = Result<Returned, PublicError>;

/** The value of `input`, as a caller gives it and `run` receives it. */
type InputOf<I extends Input> = Flat<Static<TObject<I>>>;

/** An action as an app writes it. */
type ActionDef<
	I extends Input,
	Out extends RunResult | Promise<RunResult>,
	U extends Returned,
> = {
	/** What the action does, in a sentence a person or an agent reads before calling it. */
	readonly description: string;
	/** Each key the action takes, as a field: `{ word: field.text() }`, `{}` for none. */
	readonly input: I;
	/** Return `Ok(data)` or `Err(error)`; `data` must survive JSON. */
	run(input: InputOf<I>, update: Update<U>): Out;
};

/**
 * `update` for one call: it hands each value to `listener`, which cannot
 * reach the action. After `close`, a late update goes nowhere.
 */
function updateChannel(listener: ((value: unknown) => unknown) | undefined) {
	let open = listener !== undefined;
	return {
		update(value: unknown) {
			if (!open) return;
			try {
				const heard = listener?.(value);
				if (heard instanceof Promise) heard.catch(() => undefined);
			} catch {
				// A listener's failure is its own; the action goes on.
			}
		},
		close() {
			open = false;
		},
	};
}

/** `value`, or a throw when `run` returned something other than a Result. */
function requireResult(value: unknown, description: string) {
	if (!isResult(value))
		throw new TypeError(
			`The action "${description}" must return Ok(data) or Err(error)`,
		);
	return value;
}

/**
 * Marks what `defineAction` made, whose every answer it has checked.
 * Registered, so serve knows it whichever copy of this package made it.
 */
const ACTION = Symbol.for('epicenter.action');

/**
 * Define an action from its fields and its `run`, typing `run`'s input by
 * the fields and every caller's `onUpdate` by `run`'s `update`. Calling the
 * action hands `run` the input as given: an absent field stays absent, and
 * `run` writes its own default. Throws for an empty description or a field
 * with a `default`, which its types cannot refuse.
 */
export function defineAction<
	const I extends Input,
	Out extends RunResult | Promise<RunResult>,
	U extends Returned = never,
>(def: ActionDef<I, Out, U>): Action<InputOf<I>, Out, U>;
export function defineAction(
	def: ActionDef<Input, RunResult | Promise<RunResult>, Returned>,
): Action {
	const { description, run } = def;
	if (description.trim() === '')
		throw new Error(
			'An action needs a description: what it does, in a sentence',
		);
	for (const [key, schema] of Object.entries(def.input))
		if (defaultIn(schema))
			throw new Error(
				`The action "${description}" has a default in "${key}"; no field has one, so write the default in run, such as \`limit = 50\``,
			);
	const input = objectSchema(def.input);
	const action = async (
		given: unknown,
		options?: { onUpdate?: (value: unknown) => unknown },
	) => {
		const { update, close } = updateChannel(options?.onUpdate);
		try {
			return requireResult(await run(given as never, update), description);
		} finally {
			close();
		}
	};
	return Object.assign(action, { description, input, [ACTION]: true });
}

/** Whether `value` is what `defineAction` made. */
export function isAction(value: unknown): value is Action {
	return (
		typeof value === 'function' &&
		(value as { [ACTION]?: unknown })[ACTION] === true
	);
}
