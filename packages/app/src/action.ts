/**
 * An action: a function an app exposes, carrying what the CLI, MCP, and a UI
 * need to call it: a description and the JSON Schema of its input. Call it as
 * any function, inside a run:
 *
 * ```ts
 * const learn = defineAction({
 *   description: 'Learn a word, due now',
 *   input: { word: field.text(), meaning: field.text({ optional: true }) },
 *   run: ({ word, meaning }) => words.create(word, { meaning }),
 * });
 *
 * await learn({ word: '你好' });
 * ```
 *
 * `run` may take a second argument, `update`, and call it to say where it is
 * while it runs. Annotate it, and every caller's `onUpdate` has that type:
 *
 * ```ts
 * const sync = defineAction({
 *   description: 'Copy new mail',
 *   input: { account: field.text() },
 *   async run({ account }, update: Update<{ copied: number }>) {
 *     for (const copied of await copy(account)) update({ copied });
 *     return Ok(null);
 *   },
 * });
 *
 * await sync({ account }, { onUpdate: ({ copied }) => show(copied) });
 * ```
 *
 * An update reports and is never the answer: a caller that does not listen
 * loses nothing (ADR-0879).
 */

import type { Static, TObject, TSchema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import { isActionResult, type PublicError } from './action-result.ts';
import {
	absentValue,
	defaultIn,
	type FilledKeys,
	type ObjectSchema,
	objectSchema,
} from './field.ts';

/**
 * An action's input as an app writes it: a record of fields, or of any
 * TypeBox schemas. Each is an object, so another action's `input`, a schema
 * whose `type` is text, is not one; its fields are `input.properties`.
 */
export type Input = Record<string, TSchema & object>;

/**
 * MCP's tool annotations, verbatim. They are hints the action gives an MCP
 * client, which decides from them how careful to be before a call. Serve
 * forwards them and nothing enforces them: an action that says it is
 * read-only and writes is the action's own mistake.
 */
export type Annotations = {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
};

/** What an action's declaration and the action it makes both carry. */
type Shared = {
	readonly description: string;
	readonly annotations?: Annotations;
	/**
	 * `false` keeps the action out of the tools serve offers over MCP:
	 * `tools/list` leaves it out and `tools/call` refuses its name. The
	 * command line, HTTP, pages and routines call it as any other action.
	 *
	 * It shapes the list an agent is offered, and it is not a wall: an agent
	 * with a shell can still call the action through the CLI or HTTP.
	 */
	readonly mcp?: boolean;
};

/**
 * An action's metadata, as callers read it. `input` is one complete JSON
 * Schema object, made once from the fields the action was written with: it
 * lists its `required` keys, `[]` when none is, and refuses other keys. It
 * survives `JSON.stringify` whole, so validation, MCP's `inputSchema`,
 * `--help`, and `list --json` all read this one value (ADR-0953).
 */
export type ActionMeta = Shared & { readonly input: ObjectSchema };

/**
 * What `run` calls to report while it runs. It returns at once and never
 * throws: what a listener returns is not awaited and what it throws is
 * dropped, so no caller can slow or stop the action.
 */
export type Update<U> = (value: U) => void;

/** A caller's second argument, which only an action that sends updates takes. */
type Listening<U> = [U] extends [never]
	? []
	: [options?: { onUpdate?: (value: U) => unknown }];

/**
 * An action: a function of its input, with what callers read to call it.
 * `U` is what it reports through `update` while it runs, `never` for one
 * that only returns; a bare `Action` is any action, as its input and output
 * are any.
 */
// biome-ignore lint/suspicious/noExplicitAny: a bare Action is any action, whatever it reports.
export type Action<In = any, Out = unknown, U = any> = ((
	input: In,
	...options: Listening<U>
) => Out) &
	ActionMeta;

/** What the action `A` reports while it runs, `never` when it only returns. */
export type ActionUpdate<A> = A extends (
	input: never,
	...options: infer Rest
) => unknown
	? Rest extends [options?: { onUpdate?: (value: infer U) => unknown }]
		? [] extends Required<Rest>
			? never
			: U
		: never
	: never;

/**
 * What an action may return: a value that survives JSON, which is how the CLI,
 * MCP, and a UI receive it. `undefined` arrives as `null`, and a property that
 * is `undefined` arrives absent.
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

type Answer = Result<Returned, PublicError>;
type Simplify<T> = { -readonly [K in keyof T]: T[K] } & {};

/** The value `run` receives for `input`: a switch or a list with no `min` is always there, `false` or `[]` when the caller left it out. */
export type InputOf<I extends Input> = Simplify<
	Omit<Static<TObject<I>>, FilledKeys<I>> & {
		[K in FilledKeys<I>]-?: Exclude<Static<I[K]>, undefined>;
	}
>;

/** What a caller gives for `input`: a switch or a list may be left out. */
type CallerInput<I extends Input> = Simplify<Static<TObject<I>>>;

/**
 * An action as an app writes it: `run` receives its input, typed by its
 * fields, and `update`, which it may leave out.
 */
export type ActionDef<
	I extends Input,
	Out extends Answer | Promise<Answer> = Answer | Promise<Answer>,
	U extends Returned = never,
> = Shared & {
	/** Each key the action takes, as a field: `{ word: field.text() }`. */
	readonly input: I;
	/** Returns what the caller sees, and what `--json` prints: a value that survives JSON. */
	run(input: InputOf<I>, update: Update<U>): Out;
};

function checked(value: unknown, description: string) {
	if (!isActionResult(value))
		throw new TypeError(
			`The action "${description}" must return Ok(data) or Err(error)`,
		);
	return value;
}

/**
 * `update` for one call: it hands each value to `listener`, which cannot
 * reach the action. After `close`, a late update goes nowhere.
 */
function reporting(listener: ((value: unknown) => unknown) | undefined) {
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

/**
 * Define an action from its fields and its `run`, typing `run`'s input by
 * the fields. The action carries its input as one JSON Schema object made
 * from the fields (`ActionMeta`). Calling it gives `run` an absent switch as
 * `false` and an absent list with no `min` as `[]`, as a read of a data file
 * does, however it is called. Inside `run`, the app's data and `folder` reach the folder of the run that
 * called it, however deep. The type of `run`'s `update` argument is the type
 * of every caller's `onUpdate`. Throws when the definition is wrong in a way
 * its types cannot say, such as a field with a `default`.
 */
export function defineAction<
	const I extends Input,
	Out extends Answer | Promise<Answer>,
	U extends Returned = never,
>(def: ActionDef<I, Out, U>): Action<CallerInput<I>, Out, U>;
export function defineAction(def: ActionDef<Input, Answer, Returned>): Action {
	// Fail at declaration, before a non-JSON schema can break tool discovery.
	JSON.stringify(def.input);
	const problems = actionProblems(def);
	if (problems.length)
		throw new Error(
			problems
				.map((problem) => `The action "${def.description}" ${problem}`)
				.join('\n'),
		);
	const { run, ...meta } = def;
	const input = objectSchema(def.input);
	const filled = Object.entries(def.input).flatMap(([key, schema]) => {
		const absent = absentValue(schema);
		return absent === undefined ? [] : [[key, absent] as const];
	});
	const action = (
		input: unknown,
		options?: { onUpdate?: (value: unknown) => unknown },
	) => {
		const given: Record<string, unknown> = { ...(input as object) };
		for (const [key, absent] of filled)
			if (given[key] === undefined) given[key] = structuredClone(absent);
		const { update, close } = reporting(options?.onUpdate);
		let answer: unknown;
		try {
			answer = (run as (input: unknown, update: Update<unknown>) => unknown)(
				given,
				update,
			);
		} catch (cause) {
			close();
			throw cause;
		}
		if (answer instanceof Promise)
			return answer
				.then((settled) => checked(settled, meta.description))
				.finally(close);
		close();
		return checked(answer, meta.description);
	};
	return Object.assign(action, { ...meta, input });
}

/** What an action is made of; anything else, such as `readonly`, is a typo the types let through. */
const ACTION_KEYS = new Set([
	'description',
	'input',
	'annotations',
	'mcp',
	'run',
]);

/** What is wrong with `def` as an action beyond its types, each finishing "The action … ". */
function actionProblems(def: object): string[] {
	const { description, input, mcp, run } = def as Record<string, unknown>;
	const problems: string[] = [];
	for (const key of Object.keys(def))
		if (!ACTION_KEYS.has(key))
			problems.push(`has "${key}", which an action does not take`);
	if (typeof description !== 'string' || description.trim() === '')
		problems.push('has no description');
	if (mcp !== undefined && typeof mcp !== 'boolean')
		problems.push('has an mcp flag that is not a boolean');
	if (typeof run !== 'function') problems.push('has no run');
	else if (run.constructor.name === 'AsyncGeneratorFunction')
		problems.push(
			'has a run that is an async function*; an action reports by calling update, its second argument, and returns its answer',
		);
	if (typeof input !== 'object' || input === null)
		return [...problems, 'has no input'];
	for (const [key, schema] of Object.entries(input as Input)) {
		if (typeof schema !== 'object' || schema === null || Array.isArray(schema))
			problems.push(
				`has "${key}" in its input, which is not a field; to reuse another action's input, write \`input: other.input.properties\``,
			);
		else if (defaultIn(schema))
			problems.push(
				`has a default in "${key}"; no field has one, so write the default in run, where the value is read, such as \`limit ?? 50\``,
			);
	}
	return problems;
}

/** Whether `value` is an action: a function carrying a description and input. */
export function isAction(value: unknown): value is Action {
	return (
		typeof value === 'function' &&
		typeof (value as { description?: unknown }).description === 'string' &&
		typeof (value as { input?: unknown }).input === 'object'
	);
}
