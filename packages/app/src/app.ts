/**
 * An app's code: what its `epicenter.ts` default-exports (ADR-0857). The
 * app's name, description, and the collections a program or person writes
 * are in `epicenter.json`; `epicenter.ts` adds actions and the collections
 * its own actions introduce.
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
import type { Context } from './context.ts';
import {
	COLLECTION_PATH,
	type Declaration,
	declarationProblems,
	NAME,
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

/** A collection an app's own actions introduce: its fields written with the `field` helpers. */
export type CodeCollection = { path: string; fields: Input };

type Actions = Record<string, { run: (...args: never) => unknown }>;

/** An app's code as `defineApp` returns it, its actions typed as written. */
export type App<
	A extends Actions = Actions,
	D extends Declaration = Declaration,
> = {
	/** The `epicenter.json` this code was written against. */
	declaration: D;
	/** Collections this code introduces; those in `epicenter.json` are not repeated here. */
	collections: Record<string, CodeCollection>;
	actions: A;
};

/**
 * Define an app's code against its declaration, imported from
 * `./epicenter.json`. Each action's `run` receives its input typed by its
 * fields; the app keeps each action as written, so `run`'s return value stays
 * typed for whatever calls it.
 */
export function defineApp<
	const D extends Declaration,
	I extends Record<string, Input>,
	A extends Actions,
>(
	declaration: D,
	code: {
		collections?: Record<string, CodeCollection>;
		actions: { [K in keyof I]: Action<I[K]> } & A;
	},
): App<A, D> {
	return {
		declaration,
		collections: code.collections ?? {},
		actions: code.actions,
	};
}

const NAME_PATTERN = new RegExp(NAME);
const PATH_PATTERN = new RegExp(COLLECTION_PATH);

/** Words the `epicenter` command keeps for itself: no app is named one. */
const BUILT_INS = new Set([
	'new',
	'add',
	'update',
	'types',
	'help',
	'serve',
	'sync',
	'setup',
	'open',
]);

/** What an action is made of; anything else, such as `readonly`, is a typo the types let through. */
const ACTION_KEYS = new Set([
	'description',
	'input',
	'positional',
	'annotations',
	'run',
]);

const ANNOTATION_KEYS = new Set(['title', ...Object.keys(ANNOTATION_DEFAULTS)]);

/** Flags the `epicenter` command reads itself: no field is named one. */
const GLOBAL_FLAGS = new Set(['json', 'help', 'version']);

/** The words of the actions a collection gives: four, or `show` and `save` when its path has no placeholder. */
export function collectionActionWords(name: string, path: string): string[] {
	const verbs = path.includes('{')
		? ['list', 'show', 'save', 'delete']
		: ['show', 'save'];
	return verbs.map((verb) => `${name} ${verb}`);
}

/**
 * Why `name` cannot name an app, or `undefined` when it can: it must be
 * lowercase letters, digits, and dashes, starting with a letter, and not a
 * word the `epicenter` command keeps for itself.
 */
export function nameProblem(name: unknown): string | undefined {
	if (typeof name !== 'string' || !NAME_PATTERN.test(name))
		return `${JSON.stringify(name)} is not lowercase letters, digits, and dashes, starting with a letter`;
	if (BUILT_INS.has(name)) return `"${name}" is an epicenter command`;
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
	const { name, collections = {} } = declaration as Declaration;
	if (BUILT_INS.has(name))
		problems.push(`its name "${name}" is an epicenter command`);
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

	const given = new Map<string, string>();
	for (const [key, collection] of Object.entries(collections))
		for (const words of collectionActionWords(key, collection.path))
			given.set(words, key);
	for (const [key, collection] of Object.entries(
		(app.collections ?? {}) as Record<string, unknown>,
	)) {
		if (Object.hasOwn(collections, key)) {
			problems.push(
				`collection "${key}" is declared in both epicenter.json and epicenter.ts`,
			);
			continue;
		}
		const path = (collection as { path?: unknown } | null)?.path;
		const fields = (collection as { fields?: unknown } | null)?.fields;
		if (!NAME_PATTERN.test(key))
			problems.push(
				`collection "${key}" is not lowercase letters, digits, and dashes`,
			);
		if (typeof path !== 'string' || !PATH_PATTERN.test(path))
			problems.push(
				`collection "${key}" has no path with at most one placeholder, such as words/{stem}.md`,
			);
		else
			for (const words of collectionActionWords(key, path))
				given.set(words, key);
		if (typeof fields !== 'object' || fields === null)
			problems.push(`collection "${key}" has no fields`);
	}

	const actions = app.actions as Record<string, unknown>;
	const keys = [...Object.keys(actions), ...given.keys()];
	for (const key of Object.keys(actions)) {
		const words = key.split(' ');
		if (!words.every((word) => NAME_PATTERN.test(word))) {
			problems.push(
				`action "${key}" is not words of lowercase letters, digits, and dashes, one space apart`,
			);
			continue;
		}
		const collection = given.get(key);
		if (collection !== undefined) {
			problems.push(
				`action "${key}" is one collection "${collection}" gives; name it something else`,
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
