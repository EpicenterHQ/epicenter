/**
 * An app: what its `epicenter.ts` default-exports. Collections and actions
 * are values, defined on their own and composed by `defineApp`:
 *
 * ```ts
 * import { defineAction, defineApp, defineCollection, field } from '@epicenter/app';
 *
 * const words = defineCollection({ path: 'words/{word}.md', fields: { meaning: field.text() } });
 * const settings = defineCollection({ path: 'settings.md', fields: { dailyGoal: field.integer({ optional: true }) } });
 *
 * const learn = defineAction({
 *   description: 'Learn a word',
 *   input: { word: field.text(), meaning: field.text() },
 *   run: ({ word, meaning }) => words.add({ word, meaning }),
 * });
 *
 * export default defineApp({
 *   description: 'Words I am learning',
 *   collections: { words, settings },
 *   actions: {
 *     words: { ...words.actions(), add: learn },
 *     settings: settings.actions('get', 'set'),
 *   },
 * });
 * ```
 *
 * The actions nest as they are called: `app.actions.words.add({ word })` in
 * code, `epicenter vocab words add` on the command line, `vocab_words_add`
 * over MCP. An app's name is its folder's.
 */
import { type Action, isAction } from './action.ts';
import type { AnyCollection } from './collection.ts';

/** An app's actions, nested: a key holds an action, or a group of them under that word. */
export type Actions = { readonly [word: string]: Action | Actions };

/** An app as `defineApp` returns it: what it was given, checked. */
export type App<
	C extends Record<string, AnyCollection> = Record<string, AnyCollection>,
	A extends Actions = Actions,
> = {
	readonly description: string;
	/** Each collection, by its name. */
	readonly collections: C;
	/** Each action, nested under its words. */
	readonly actions: A;
};

/**
 * Define an app: its description, its collections, and its actions, each
 * given, `{}` for none. Each collection's name is its key in `collections`;
 * each action's words are its keys in `actions`, so
 * `words: { ...words.actions(), add: learn }` gives `words list` through
 * `words delete`, with `words add` replaced by `learn`. A later key replaces
 * an earlier one, as in any object. Returns `app` itself; throws when it is
 * wrong in a way its types cannot say, so `epicenter` checks an app it loads
 * by calling this again.
 */
export function defineApp<
	const C extends Record<string, AnyCollection>,
	const A extends Actions,
>(app: App<C, A>): App<C, A> {
	const problems = appProblems(app);
	if (problems.length) throw new Error(problems.join('\n'));
	return app;
}

/**
 * Whether `value` is a name: lowercase letters, digits, and dashes, starting
 * with a letter. An app's folder, a collection, and each of an action's words
 * are named so.
 */
export function isName(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
}

const notName =
	'which is not lowercase letters, digits, and dashes, starting with a letter';

const isObject = (value: unknown): value is object =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** What is wrong with `app` beyond its types, one sentence each. */
function appProblems(app: unknown): string[] {
	if (!isObject(app))
		return [
			'An app is an object: defineApp({ description, collections, actions })',
		];
	const { description, collections, actions } = app as Partial<App>;
	const problems: string[] = [];
	if (typeof description !== 'string' || description.trim() === '')
		problems.push('An app needs a description');
	if (!isObject(collections))
		problems.push(
			'An app needs collections: an object of defineCollection(...), {} for none',
		);
	if (!isObject(actions))
		problems.push(
			'An app needs actions: an object of defineAction(...) and groups of them, {} for none',
		);
	const entries = Object.entries(isObject(collections) ? collections : {});
	for (const [name, collection] of entries) {
		if (!isName(name))
			problems.push(
				`collections has the key ${JSON.stringify(name)}, ${notName}`,
			);
		if (typeof (collection as Partial<AnyCollection>)?.holds !== 'function')
			problems.push(`collections.${name} is not defineCollection(...)`);
	}
	// Overlaps are read only from collections that are all defineCollection(...).
	if (problems.length === 0)
		for (const [at, [a, first]] of entries.entries())
			for (const [b, second] of entries.slice(at + 1)) {
				const shared = clash(first, second) ?? clash(second, first);
				if (shared)
					problems.push(
						`collections "${a}" and "${b}" would both hold ${shared}`,
					);
			}
	const walk = (group: object, words: string[]) => {
		for (const [word, entry] of Object.entries(group)) {
			const at = `actions.${[...words, word].join('.')}`;
			if (!isName(word))
				problems.push(
					`actions has the key ${JSON.stringify(word)} at ${at}, ${notName}`,
				);
			else if (word === 'then')
				problems.push(
					`${at} is named "then", which a UI cannot call, since awaiting a value reads its then; name it another word`,
				);
			else if (isAction(entry)) continue;
			else if (typeof entry !== 'object' || entry === null)
				problems.push(`${at} is neither an action nor a group of them`);
			else if ('run' in entry || 'description' in entry)
				problems.push(
					`${at} is not an action: make it with defineAction(...), and change one with defineAction({ ... }) rather than a spread, which drops the call`,
				);
			else walk(entry, [...words, word]);
		}
	};
	if (isObject(actions)) walk(actions, []);
	return problems;
}

/**
 * A file both collections would hold: the same template, or one's one-file
 * path that the other's template matches. Two different templates with
 * placeholders that can match one file are not caught.
 */
function clash(a: AnyCollection, b: AnyCollection): string | undefined {
	if (a.path === b.path || (!a.path.includes('{') && b.holds(a.path)))
		return a.path;
	return undefined;
}
