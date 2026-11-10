/**
 * An app's code: what its `epicenter.ts` default-exports (ADR-0857). The
 * app's description and every collection are in `epicenter.json`, and its name
 * is its folder's; `epicenter.ts` holds actions and nothing else of the app's
 * shape. Each collection gives actions of its own (`collection.ts`), and a
 * written action with the same words replaces one (ADR-0853).
 *
 * ```ts
 * import declaration from './epicenter.json';
 * import { defineApp, field } from '@epicenter/app';
 *
 * export default defineApp(declaration, {
 *   actions: {
 *     log: {
 *       description: 'Record minutes read today',
 *       input: { minutes: field.number() },
 *       positional: ['minutes'],
 *       run: async ({ minutes }, { folder }) => { ... },
 *     },
 *   },
 * });
 * ```
 */
import type { Static, TObject, TSchema } from 'typebox';
import { allCollectionActions, collectionProblems } from './collection.ts';
import type { Context } from './context.ts';
import {
	type Declaration,
	declarationProblems,
	isName,
} from './declaration.ts';

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

/**
 * MCP's tool annotations, verbatim, with MCP's defaults: an action that does
 * not say otherwise may change things (`readOnlyHint: false`), may destroy
 * (`destructiveHint: true`), is not idempotent, and reaches outside the
 * folder (`openWorldHint: true`). The last three mean something only when
 * the action is not read-only.
 */
export type Annotations = {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
};

/** MCP's defaults for each hint an action does not give. */
export const ANNOTATION_DEFAULTS = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: true,
} as const;

/** One action: what `epicenter <app> <action words>` runs. */
export type Action<I extends Input = Input> = {
	description: string;
	input: I;
	/**
	 * The inputs the command line also reads by position, in order:
	 * `positional: ['from', 'to']` reads `epicenter reading between 2026-11-01 2026-11-08`.
	 * Not part of the input's schema; flags always work too.
	 */
	positional?: readonly (keyof I & string)[];
	annotations?: Annotations;
	/** Returns what the person sees, and what `--json` prints. */
	run(input: InputOf<I>, context: Context): unknown;
};

type Actions = Record<string, { run: (...args: never) => unknown }>;

/** An app's code as `defineApp` returns it, its actions typed as written. */
export type App<A extends Actions = Actions> = {
	actions: A;
};

/**
 * Define an app's code. Each action's `run` receives its input typed by its
 * fields; the app keeps each action as written, so `run`'s return value stays
 * typed for whatever calls it.
 *
 * The `epicenter.json` on disk is the app's declaration: `epicenter` reads it
 * there, never from this call. `declaration`, imported from
 * `./epicenter.json`, is taken now so that collection handles in `run` can be
 * typed from it when they arrive (K1, K2), without changing any app.
 */
export function defineApp<I extends Record<string, Input>, A extends Actions>(
	_declaration: Declaration,
	code: {
		actions: { [K in keyof I]: Action<I[K]> } & A;
	},
): App<A> {
	return { actions: code.actions };
}

/**
 * The commands `epicenter` keeps for itself, each with its usage. The CLI
 * dispatches from this table and prints its help from it, and no app may be
 * named one of its words.
 */
export const COMMANDS = {
	new: 'epicenter new <name>',
	add: 'epicenter add <folder> [<name>] | add <git url> [<name>]',
	install: 'epicenter install <path|git url> [<name>] | install <app>',
	sync: 'epicenter sync [<app>]',
	serve: 'epicenter serve [--port <n>] [--host <address>] | serve --stdio',
} as const;

export type Command = keyof typeof COMMANDS;

function isCommand(name: string): name is Command {
	return Object.hasOwn(COMMANDS, name);
}

/** What an action is made of; anything else, such as `readonly`, is a typo the types let through. */
const ACTION_KEYS = new Set([
	'description',
	'input',
	'positional',
	'annotations',
	'run',
]);

const ANNOTATION_KEYS = new Set(['title', ...Object.keys(ANNOTATION_DEFAULTS)]);

/**
 * Flags the `epicenter` command reads anywhere among an action's words: no
 * field is named one. `--version` is read only on its own, so a field may be
 * named `version`.
 */
const GLOBAL_FLAGS = new Set(['json', 'help', 'input']);

/**
 * Why `name` cannot name an app, or `undefined` when it can: it must be
 * lowercase letters, digits, and dashes, starting with a letter, and not a
 * word the `epicenter` command keeps for itself.
 */
export function nameProblem(name: unknown): string | undefined {
	if (!isName(name))
		return `${JSON.stringify(name)} is not lowercase letters, digits, and dashes, starting with a letter`;
	if (isCommand(name)) return `"${name}" is an epicenter command`;
	return undefined;
}

/**
 * What is wrong with an app, one sentence each; empty when nothing is.
 * `declaration` is the parsed `epicenter.json`; `code` is `epicenter.ts`'s
 * default export, when the folder has one. The CLI lists an app with problems
 * and does not run it.
 */
export function problemsOf(declaration: unknown, code?: unknown): string[] {
	const problems = declarationProblems(declaration);
	if (problems.length) return problems;
	const { collections = {} } = declaration as Declaration;
	const paths = new Map<string, string>();
	for (const [key, collection] of Object.entries(collections)) {
		const other = paths.get(collection.path);
		if (other !== undefined)
			problems.push(
				`collections "${other}" and "${key}" share the path ${collection.path}`,
			);
		else paths.set(collection.path, key);
		problems.push(
			...collectionProblems(collection).map(
				(problem) => `collection "${key}" ${problem}`,
			),
		);
	}
	const given = allCollectionActions(collections);
	for (const [key, action] of Object.entries(given))
		problems.push(
			...actionProblems(action).map((problem) => `action "${key}" ${problem}`),
		);
	if (code === undefined) return problems;
	const app = code as Record<string, unknown> | null;
	if (
		typeof app !== 'object' ||
		app === null ||
		typeof app.actions !== 'object' ||
		app.actions === null
	)
		return [
			...problems,
			'epicenter.ts does not export defineApp(...) by default',
		];
	const actions = app.actions as Record<string, unknown>;
	// A written action with a collection's words replaces it, so only the others can clash.
	const keys = [...new Set([...Object.keys(actions), ...Object.keys(given)])];
	for (const key of Object.keys(actions)) {
		const words = key.split(' ');
		if (!words.every(isName)) {
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
			...actionProblems(actions[key]).map(
				(problem) => `action "${key}" ${problem}`,
			),
		);
	}
	return problems;
}

/** An app's actions: each collection's, with `epicenter.ts`'s laid over them by their words. */
export function appActions(
	declaration: Declaration,
	code?: App,
): Record<string, Action> {
	return {
		...allCollectionActions(declaration.collections),
		...(code?.actions as Record<string, Action> | undefined),
	};
}

function actionProblems(action: unknown): string[] {
	if (typeof action !== 'object' || action === null)
		return ['is not an action'];
	const { description, input, positional, annotations, run } = action as Record<
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
	if (annotations !== undefined) {
		if (typeof annotations !== 'object' || annotations === null)
			problems.push('has annotations that are not an object');
		else
			for (const key of Object.keys(annotations))
				if (!ANNOTATION_KEYS.has(key))
					problems.push(
						`has the annotation "${key}", which MCP does not define`,
					);
	}
	if (typeof input !== 'object' || input === null)
		return [...problems, 'has no input'];
	const fields = input as Record<string, TSchema>;
	for (const key of Object.keys(fields))
		if (GLOBAL_FLAGS.has(key))
			problems.push(`has a field named "${key}", which epicenter reads itself`);
	if (positional === undefined) return problems;
	if (!Array.isArray(positional))
		return [...problems, 'has a positional that is not a list of its fields'];
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
