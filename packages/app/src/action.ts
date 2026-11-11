/**
 * An action: a function an app exposes, carrying what the CLI, MCP, and a UI
 * need to call it: a description, its input's fields, and how the command
 * line reads them. Call it as any function, inside a run:
 *
 * ```ts
 * const learn = defineAction({
 *   description: 'Learn a word, due now',
 *   input: { word: field.text(), meaning: field.text({ optional: true }) },
 *   positional: ['word', 'meaning'],
 *   run: ({ word, meaning }) => words.add({ word, meaning }),
 * });
 *
 * await learn({ word: '你好' });
 * ```
 *
 * `run` may be an `async function*`: what it yields reaches only the view that
 * called it, as it runs, and what it returns is the answer (ADR-0879). Called
 * as a function, such an action resolves with its return, its yields unread.
 */
import { type Static, type TObject, type TSchema, Type } from 'typebox';
import { Value } from 'typebox/value';

/** An action's input: a record of fields, or of any TypeBox schemas. */
export type Input = Record<string, TSchema>;

/**
 * MCP's tool annotations, verbatim. An action that does not say otherwise
 * may change things, may destroy, is not idempotent, and reaches outside the
 * folder; the last three mean something only when it is not read-only. A
 * read-only action's run is never snapshotted into the app's history, and a
 * write through `folder` in it throws, except to a `.local` path.
 */
export type Annotations = {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
};

/** What the CLI, MCP, and a UI read from an action besides calling it. */
export type ActionMeta = {
	readonly description: string;
	readonly input: Input;
	/**
	 * The inputs the command line also reads by position, in order:
	 * `positional: ['from', 'to']` reads `epicenter reading between 2026-11-01 2026-11-08`.
	 */
	readonly positional?: readonly string[];
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

type DefaultedKeys<I extends Input> = {
	[K in keyof I]: I[K] extends { default: unknown } ? K : never;
}[keyof I];

type Simplify<T> = { -readonly [K in keyof T]: T[K] } & {};

/** The value `run` receives for `input`: a field with a default is always there. */
export type InputOf<I extends Input> = Simplify<
	Omit<Static<TObject<I>>, DefaultedKeys<I>> & {
		[K in DefaultedKeys<I>]-?: Exclude<Static<I[K]>, undefined>;
	}
>;

/** What a caller gives for `input`: a field with a default may be left out. */
type CallerInput<I extends Input> = Simplify<
	Omit<Static<TObject<I>>, DefaultedKeys<I>> & {
		[K in DefaultedKeys<I>]?: Exclude<Static<I[K]>, undefined>;
	}
>;

/** What an action is besides its `run`, as an app writes it. */
type ActionFields<I extends Input> = {
	description: string;
	input: I;
	positional?: readonly (keyof I & string)[];
	annotations?: Annotations;
};

/** An action as an app writes it: `run` receives its input, typed by its fields. */
export type ActionDef<
	I extends Input,
	Out extends Returned | Promise<Returned> = Returned | Promise<Returned>,
> = ActionFields<I> & {
	/** Returns what the caller sees, and what `--json` prints: a value that survives JSON. */
	run(input: InputOf<I>): Out;
};

/** An action whose `run` yields values that survive JSON while it runs, then returns its answer. */
export type YieldingActionDef<
	I extends Input,
	Y extends Returned,
	R extends Returned,
> = ActionFields<I> & {
	run(input: InputOf<I>): AsyncGenerator<Y, R, undefined>;
};

/** The undefaulted `run`, kept on the action for `runYielding`. */
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
 * which the next step waits for. An action that only returns just returns.
 * This is the one place an action's yields are read (ADR-0879).
 */
export async function runYielding(
	action: Action,
	input: unknown,
	onYield: (value: unknown) => unknown,
): Promise<unknown> {
	const run = (action as { [RUN]?: (input: unknown) => unknown })[RUN];
	const result = run ? run(input) : action(input);
	if (!isAsyncGenerator(result)) return result;
	for (;;) {
		const step = await result.next();
		if (step.done) return step.value;
		await onYield(step.value);
	}
}

/**
 * Define an action from its fields and its `run`, typing `run`'s input by
 * the fields. Calling it fills each field's default before `run`, as a call
 * through the CLI or MCP does. Inside `run`, the app's collections and
 * `folder` reach the folder of the run that called it, however deep. Throws
 * when the definition is wrong in a way its types cannot say.
 */
export function defineAction<
	const I extends Input,
	Y extends Returned,
	R extends Returned,
>(def: YieldingActionDef<I, Y, R>): Action<CallerInput<I>, Promise<R>, Y>;
export function defineAction<
	const I extends Input,
	Out extends Returned | Promise<Returned>,
>(def: ActionDef<I, Out>): Action<CallerInput<I>, Out, never>;
export function defineAction(
	def: ActionDef<Input> | YieldingActionDef<Input, Returned, Returned>,
): Action {
	const problems = actionProblems(def);
	if (problems.length)
		throw new Error(
			problems
				.map((problem) => `The action "${def.description}" ${problem}`)
				.join('\n'),
		);
	const { run, ...meta } = def;
	const schema = Type.Object(def.input);
	const start = (input: unknown) =>
		(run as (input: unknown) => unknown)(
			Value.Default(schema, { ...(input as object) }),
		);
	const action = (input: unknown) => {
		const result = start(input);
		return isAsyncGenerator(result)
			? runYielding(action as Action, input, () => undefined)
			: result;
	};
	return Object.assign(action, meta, { [RUN]: start });
}

/**
 * Flags the `epicenter` command reads anywhere among an action's words: no
 * field is named one. `--version` is read only on its own, so a field may be
 * named `version`.
 */
export const RESERVED_FIELDS: ReadonlySet<string> = new Set([
	'json',
	'help',
	'input',
]);

/** What an action is made of; anything else, such as `readonly`, is a typo the types let through. */
const ACTION_KEYS = new Set([
	'description',
	'input',
	'positional',
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

/** What is wrong with `def` as an action beyond its types, each finishing "The action … ". */
function actionProblems(def: object): string[] {
	const { description, input, positional, annotations, run } = def as Record<
		string,
		unknown
	>;
	const problems: string[] = [];
	for (const key of Object.keys(def))
		if (!ACTION_KEYS.has(key))
			problems.push(`has "${key}", which an action does not take`);
	if (typeof description !== 'string' || description.trim() === '')
		problems.push('has no description');
	if (typeof run !== 'function') problems.push('has no run');
	if (typeof annotations === 'object' && annotations !== null)
		for (const key of Object.keys(annotations))
			if (!ANNOTATION_KEYS.has(key))
				problems.push(`has the annotation "${key}", which MCP does not define`);
	if (typeof input !== 'object' || input === null)
		return [...problems, 'has no input'];
	const fields = input as Input;
	for (const key of Object.keys(fields))
		if (RESERVED_FIELDS.has(key))
			problems.push(`has a field named "${key}", which epicenter reads itself`);
	if (!Array.isArray(positional)) return problems;
	positional.forEach((key: unknown, index) => {
		if (typeof key !== 'string' || !Object.hasOwn(fields, key))
			problems.push(
				`has the positional ${JSON.stringify(key)}, which is not one of its fields`,
			);
		else if (positional.indexOf(key) !== index)
			problems.push(`lists the positional "${key}" twice`);
		else if (
			(fields[key] as { type?: unknown }).type === 'array' &&
			index !== positional.length - 1
		)
			problems.push(
				`has the list "${key}" as a positional before the last, so the ones after it could never be given`,
			);
	});
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
