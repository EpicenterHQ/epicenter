/**
 * An app: what its `epicenter.ts` default-exports. Collections and actions
 * are values, defined on their own and composed by `defineApp`:
 *
 * ```ts
 * import { defineAction, defineApp, defineCollection, field } from '@epicenter/app';
 *
 * const words = defineCollection({ path: 'words/{word}.md', fields: { meaning: field.text() } });
 * const settings = defineCollection({ path: 'settings.md', fields: { dailyGoal: field.integer() } });
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
 * Define an app: its description, its collections, and its actions. Each
 * collection's name is its key in `collections`; each action's words are its
 * keys in `actions`, so `words: { ...words.actions(), add: learn }` gives
 * `words list` through `words delete`, with `words add` replaced by `learn`.
 * A later key replaces an earlier one, as in any object. Returns what it was
 * given; throws when that is wrong in a way its types cannot say.
 */
export function defineApp<
	const C extends Record<string, AnyCollection> = {},
	const A extends Actions = {},
>(app: { description: string; collections?: C; actions?: A }): App<C, A> {
	const defined = {
		description: app.description,
		collections: app.collections ?? ({} as C),
		actions: app.actions ?? ({} as A),
	};
	const problems = appProblems(defined);
	if (problems.length) throw new Error(problems.join('\n'));
	return defined;
}

/** Whether `value` is an app: what `defineApp` returns. */
export function isApp(value: unknown): value is App {
	const app = value as Partial<App> | null;
	return (
		typeof app === 'object' &&
		app !== null &&
		typeof app.description === 'string' &&
		typeof app.collections === 'object' &&
		typeof app.actions === 'object'
	);
}

/**
 * Whether `value` is a name: lowercase letters, digits, and dashes, starting
 * with a letter. An app's folder, a collection, and each of an action's words
 * are named so.
 */
export function isName(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
}

const notName = 'which is not lowercase letters, digits, and dashes, starting with a letter';

/** What is wrong with `app` beyond its types, one sentence each. */
function appProblems(app: App): string[] {
	const problems: string[] = [];
	if (typeof app.description !== 'string' || app.description.trim() === '')
		problems.push('An app needs a description');
	const collections = Object.entries(app.collections);
	for (const [name, collection] of collections) {
		if (!isName(name))
			problems.push(`collections has the key ${JSON.stringify(name)}, ${notName}`);
		if (typeof (collection as Partial<AnyCollection>)?.holds !== 'function')
			problems.push(`collections.${name} is not defineCollection(...)`);
	}
	// Overlaps are read only from collections that are all defineCollection(...).
	if (problems.length === 0)
		for (const [at, [a, first]] of collections.entries())
			for (const [b, second] of collections.slice(at + 1)) {
				const shared = clash(first, second) ?? clash(second, first);
				if (shared)
					problems.push(
						`collections "${a}" and "${b}" would both hold ${shared}`,
					);
			}
	const walk = (group: unknown, words: string[]) => {
		for (const [word, entry] of Object.entries(group as object)) {
			const at = `actions.${[...words, word].join('.')}`;
			if (!isName(word))
				problems.push(`actions has the key ${JSON.stringify(word)} at ${at}, ${notName}`);
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
	walk(app.actions, []);
	return problems;
}

/**
 * A file both collections would hold: the same template, or one's one-file
 * path that the other's template matches. Overlap between two templates with
 * placeholders in general is left to `sync`, which names any file two
 * collections hold.
 */
function clash(a: AnyCollection, b: AnyCollection): string | undefined {
	const theirs = [b.path].flat();
	return [a.path]
		.flat()
		.find(
			(text) => theirs.includes(text) || (!text.includes('{') && b.holds(text)),
		);
}
