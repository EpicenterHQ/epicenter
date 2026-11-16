/**
 * An action: a function an app exposes, carrying what the CLI, MCP, and a UI
 * need to call it: a description and its input's fields. Call it as any
 * function, inside a run:
 *
 * ```ts
 * const learn = defineAction({
 *   description: 'Learn a word, due now',
 *   input: { word: field.text(), meaning: field.text({ optional: true }) },
 *   run: ({ word, meaning }) => words.add({ word, meaning }),
 * });
 *
 * await learn({ word: '你好' });
 * ```
 *
 * `run` may be an `async function*`: what it yields reaches only the UI that
 * called it, as it runs, and what it returns is the answer (ADR-0879). Called
 * as a function, such an action resolves with its return, its yields unread.
 */

import type { Static, TObject, TSchema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import { isActionResult, type PublicError } from './action-result.ts';
import {
	absentValue,
	defaultIn,
	type FilledKeys,
	fileFieldOf,
} from './field.ts';

/** An action's input: a record of fields, or of any TypeBox schemas. */
export type Input = Record<string, TSchema>;

/**
 * MCP's tool annotations, verbatim. An action that does not say otherwise
 * may change things, may destroy, is not idempotent, and reaches outside the
 * folder; the last three mean something only when it is not read-only. A
 * read-only action's write through `folder` throws, except to a `.local` path.
 */
export type Annotations = {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
};

/** An action's metadata, shared by its declaration and callers. */
export type ActionMeta<I extends Input = Input> = {
	readonly description: string;
	readonly input: I;
	/**
	 * Handle the whole input privately: exclude MCP, accept CLI input only as
	 * JSON stdin, and omit input from validation details and commit names.
	 * HTTP JSON remains available. The app owns its outputs and storage.
	 */
	readonly privateInput?: boolean;
	readonly annotations?: Annotations;
};

/** Where an action's type keeps what it yields; nothing is there at runtime. */
declare const yields: unique symbol;

/**
 * An action: a function of its input, with what callers read to call it.
 * `Yield` is what it yields while it runs, `never` for one that only returns;
 * a bare `Action` is any action, as its input and output are any.
 */
export type Action<In = any, Out = unknown, Yield = unknown> = ((
	input: In,
) => Out) &
	ActionMeta & { readonly [yields]?: Yield };

/** What the action `A` yields while it runs, `never` when it only returns. */
export type ActionYield<A> = A extends { readonly [yields]?: infer Y }
	? [Y] extends [undefined]
		? never
		: Exclude<Y, undefined>
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

/** An action as an app writes it: `run` receives its input, typed by its fields. */
export type ActionDef<
	I extends Input,
	Out extends Answer | Promise<Answer> = Answer | Promise<Answer>,
> = ActionMeta<I> & {
	/** Returns what the caller sees, and what `--json` prints: a value that survives JSON. */
	run(input: InputOf<I>): Out;
};

/** An action whose `run` yields values that survive JSON while it runs, then returns its answer. */
export type YieldingActionDef<
	I extends Input,
	Y extends Returned,
	R extends Answer,
> = ActionMeta<I> & {
	run(input: InputOf<I>): AsyncGenerator<Y, R, undefined>;
};

/** `run` as a call starts it, its input filled but its yields unread, kept on the action for `runYielding`. */
const RUN = Symbol('run');

function isAsyncGenerator(
	value: unknown,
): value is AsyncGenerator<unknown, unknown, undefined> {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as AsyncGenerator).next === 'function' &&
		typeof (value as AsyncGenerator)[Symbol.asyncIterator] === 'function'
	);
}

/**
 * Run `action` with `input`, giving each value it yields to `onYield` in
 * order, and resolve with what it returned. `onYield` may return a promise,
 * which the next step waits for; when it throws, the action is stopped where
 * it yielded, its `finally` blocks run, and the call throws that. An action
 * that only returns just returns. This is the one place an action's yields
 * are read (ADR-0879).
 */
export async function runYielding(
	action: Action,
	input: unknown,
	onYield: (value: unknown) => unknown,
): Promise<Result<unknown, PublicError>> {
	const run = (action as { [RUN]?: (input: unknown) => unknown })[RUN];
	return settle(run ? run(input) : action(input), onYield, action.description);
}

function checked(value: unknown, description: string) {
	if (!isActionResult(value))
		throw new TypeError(
			`The action "${description}" must return Ok(data) or Err(error)`,
		);
	return value;
}

function settle(
	value: unknown,
	onYield: (value: unknown) => unknown,
	description: string,
) {
	if (isAsyncGenerator(value)) return drain(value, onYield, description);
	if (value instanceof Promise)
		return value.then((answer) => checked(answer, description));
	return checked(value, description);
}

async function drain(
	generator: AsyncGenerator<unknown, unknown, undefined>,
	onYield: (value: unknown) => unknown,
	description: string,
) {
	let finished = false;
	try {
		for (;;) {
			const step = await generator.next();
			if (step.done) {
				finished = true;
				return checked(step.value, description);
			}
			await onYield(step.value);
		}
	} finally {
		if (!finished) await generator.return(undefined);
	}
}

/**
 * Define an action from its fields and its `run`, typing `run`'s input by
 * the fields. Calling it gives `run` an absent switch as `false` and an absent
 * list with no `min` as `[]`, as a read of a collection does, however it is called. Inside
 * `run`, the app's collections and `folder` reach the folder of the run that
 * called it, however deep. Throws when the definition is wrong in a way its
 * types cannot say, such as a field with a `default`.
 */
export function defineAction<
	const I extends Input,
	Y extends Returned,
	R extends Answer,
>(def: YieldingActionDef<I, Y, R>): Action<CallerInput<I>, Promise<R>, Y>;
export function defineAction<
	const I extends Input,
	Out extends Answer | Promise<Answer>,
>(def: ActionDef<I, Out>): Action<CallerInput<I>, Out, never>;
export function defineAction(
	def: ActionDef<Input> | YieldingActionDef<Input, Returned, Answer>,
): Action {
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
	const filled = Object.entries(def.input).flatMap(([key, schema]) => {
		const absent = absentValue(schema);
		return absent === undefined ? [] : [[key, absent] as const];
	});
	const start = (input: unknown) => {
		const given: Record<string, unknown> = { ...(input as object) };
		for (const [key, absent] of filled)
			if (given[key] === undefined) given[key] = structuredClone(absent);
		return (run as (input: unknown) => unknown)(given);
	};
	const action = (input: unknown) =>
		settle(start(input), () => undefined, meta.description);
	return Object.assign(action, meta, { [RUN]: start });
}

/** What an action is made of; anything else, such as `readonly`, is a typo the types let through. */
const ACTION_KEYS = new Set([
	'description',
	'input',
	'privateInput',
	'annotations',
	'run',
]);

const ANNOTATION_KEYS = new Set([
	'title',
	'readOnlyHint',
	'destructiveHint',
	'idempotentHint',
	'openWorldHint',
]);

/** File handles are decoded only for whole top-level input fields. */
function containsFileMarker(
	value: unknown,
	seen = new WeakSet<object>(),
): boolean {
	if (!value || typeof value !== 'object' || seen.has(value)) return false;
	seen.add(value);
	return (
		Object.hasOwn(value, 'x-epicenter-file') ||
		Object.values(value).some((child) => containsFileMarker(child, seen))
	);
}

/** What is wrong with `def` as an action beyond its types, each finishing "The action … ". */
function actionProblems(def: object): string[] {
	const { description, input, privateInput, annotations, run } = def as Record<
		string,
		unknown
	>;
	const problems: string[] = [];
	for (const key of Object.keys(def))
		if (key === 'positional')
			problems.push(
				`has "positional", which an action no longer takes: the command line reads its input as one JSON object, so delete the line`,
			);
		else if (!ACTION_KEYS.has(key))
			problems.push(`has "${key}", which an action does not take`);
	if (typeof description !== 'string' || description.trim() === '')
		problems.push('has no description');
	if (typeof run !== 'function') problems.push('has no run');
	if (privateInput !== undefined && typeof privateInput !== 'boolean')
		problems.push('has a privateInput flag that is not a boolean');
	if (typeof annotations === 'object' && annotations !== null)
		for (const key of Object.keys(annotations))
			if (!ANNOTATION_KEYS.has(key))
				problems.push(`has the annotation "${key}", which MCP does not define`);
	if (typeof input !== 'object' || input === null)
		return [...problems, 'has no input'];
	for (const [key, schema] of Object.entries(input as Input)) {
		if (!fileFieldOf(schema) && containsFileMarker(schema))
			problems.push(
				`has a nested file in "${key}"; files must be top-level action inputs`,
			);
		if (defaultIn(schema))
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
