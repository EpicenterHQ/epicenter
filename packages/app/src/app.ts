/**
 * An app is a folder whose `epicenter.ts` default-exports `defineApp(...)`
 * (ADR-0841): a name, a description, and actions. The `epicenter` CLI turns
 * every action into a command for the person and a tool for their agent.
 *
 * ```ts
 * export default defineApp({
 *   name: 'reading',
 *   description: 'How much I read each week',
 *   actions: {
 *     log: {
 *       description: 'Record minutes read today',
 *       input: { minutes: field.number({ positional: true }) },
 *       run: async ({ minutes }, { folder }) => { ... },
 *     },
 *   },
 * });
 * ```
 */
import type { Static, TObject, TSchema } from 'typebox';
import { isPositional } from './field.ts';
import type { Places } from './places.ts';

/** An action's input: a plain record of fields, or of any TypeBox schemas. */
export type Input = Record<string, TSchema>;

/** The value `run` receives for `input`: a field with a default is always there. */
export type InputOf<I extends Input> = Simplify<
	Omit<Static<TObject<I>>, DefaultedKeys<I>> & {
		[K in DefaultedKeys<I>]-?: Exclude<Static<I[K]>, undefined>;
	}
>;

type DefaultedKeys<I extends Input> = {
	[K in keyof I]: I[K] extends { default: unknown } ? K : never;
}[keyof I];

type Simplify<T> = { [K in keyof T]: T[K] };

/** One action: what `epicenter <app> <action words>` runs. */
export type Action<I extends Input = Input> = {
	description: string;
	input: I;
	/** Changes nothing anywhere; an agent may run it freely. */
	readOnly?: boolean;
	/** Changes something outside the folder that cannot be taken back, such as archiving mail. */
	destructive?: boolean;
	/** Returns what the person sees, and what `--json` prints. */
	run(input: InputOf<I>, places: Places): unknown;
};

type Actions = Record<string, { run: (...args: never) => unknown }>;

/** An app as `defineApp` returns it, its actions typed as written. */
export type App<A extends Actions = Actions> = {
	name: string;
	description: string;
	actions: A;
};

/**
 * Define an app. Each action's `run` receives its input typed by its fields;
 * the app keeps each action as written, so `run`'s return value stays typed
 * for whatever calls it.
 */
export function defineApp<
	I extends Record<string, Input>,
	A extends Actions,
>(app: {
	name: string;
	description: string;
	actions: { [K in keyof I]: Action<I[K]> } & A;
}): App<A> {
	return app;
}

const NAME = /^[a-z][a-z0-9-]*$/;

/** Words the `epicenter` command keeps for itself: no app is named one. */
const BUILT_INS = new Set([
	'new',
	'add',
	'update',
	'sync',
	'mcp',
	'help',
	'serve',
	'open',
]);

/** What an action is made of; anything else, such as `readonly`, is a typo the types let through. */
const ACTION_KEYS = new Set([
	'description',
	'input',
	'run',
	'readOnly',
	'destructive',
]);

/** Flags the `epicenter` command reads itself: no field is named one. */
const GLOBAL_FLAGS = new Set(['json', 'help', 'version']);

/**
 * What is wrong with `app` as an app's default export, one sentence each;
 * empty when nothing is. The CLI lists an app with problems and does not run
 * it.
 */
export function problemsOf(app: unknown): string[] {
	if (typeof app !== 'object' || app === null)
		return ['epicenter.ts does not export an app by default'];
	const { name, description, actions } = app as Record<string, unknown>;
	const problems: string[] = [];
	if (typeof name !== 'string' || !NAME.test(name))
		problems.push(
			`its name ${JSON.stringify(name)} is not lowercase letters, digits, and dashes, starting with a letter`,
		);
	else if (BUILT_INS.has(name))
		problems.push(`its name "${name}" is an epicenter command`);
	if (typeof description !== 'string' || description === '')
		problems.push('it has no description');
	if (typeof actions !== 'object' || actions === null)
		return [...problems, 'it has no actions'];

	const keys = Object.keys(actions);
	for (const key of keys) {
		const words = key.split(' ');
		if (!words.every((word) => NAME.test(word))) {
			problems.push(
				`action "${key}" is not words of lowercase letters, digits, and dashes, one space apart`,
			);
			continue;
		}
		const longer = keys.find((other) => other.startsWith(`${key} `));
		if (longer !== undefined)
			problems.push(
				`action "${key}" is the start of action "${longer}", so "${longer}" could not be told apart`,
			);
		problems.push(
			...actionProblems((actions as Record<string, unknown>)[key]).map(
				(problem) => `action "${key}" ${problem}`,
			),
		);
	}
	return problems;
}

function actionProblems(action: unknown): string[] {
	if (typeof action !== 'object' || action === null)
		return ['is not an action'];
	const { description, input, run, readOnly, destructive } = action as Record<
		string,
		unknown
	>;
	const problems: string[] = [];
	for (const key of Object.keys(action))
		if (!ACTION_KEYS.has(key))
			problems.push(`has "${key}", which an action does not take`);
	if (typeof description !== 'string' || description === '')
		problems.push('has no description');
	if (typeof run !== 'function') problems.push('has no run');
	if (readOnly === true && destructive === true)
		problems.push('is both readOnly and destructive');
	if (typeof input !== 'object' || input === null)
		return [...problems, 'has no input'];
	const fields = Object.entries(input as Record<string, TSchema>);
	for (const [key] of fields)
		if (GLOBAL_FLAGS.has(key))
			problems.push(`has a field named "${key}", which epicenter reads itself`);
	const positionals = fields.filter(([, schema]) => isPositional(schema));
	if (positionals.length > 1)
		problems.push(
			`has ${positionals.length} positional fields (${positionals.map(([key]) => key).join(', ')}); at most one`,
		);
	return problems;
}
