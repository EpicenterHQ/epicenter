/**
 * An app: what its `epicenter.ts` default-exports. Its data and actions are
 * values, defined on their own and composed by `defineApp`:
 *
 * ```ts
 * import { defineAction, defineApp, defineData, field } from '@epicenter/app';
 *
 * const data = defineData({
 *   words: { fields: { meaning: field.text() } },
 *   'settings.md': { fields: { dailyGoal: field.integer({ optional: true }) } },
 * });
 *
 * const learn = defineAction({
 *   description: 'Learn a word',
 *   input: { word: field.text(), meaning: field.text() },
 *   run: ({ word, meaning }) => data.words.add(word, { meaning }),
 * });
 *
 * export default defineApp({
 *   description: 'Words I am learning',
 *   data,
 *   actions: {
 *     words: { ...data.words.actions('list', 'get', 'set'), add: learn },
 *     settings: data['settings.md'].actions('get', 'set'),
 *   },
 * });
 * ```
 *
 * The actions nest as they are called: `app.actions.words.add({ word })` in
 * code, `epicenter vocab words add` on the command line, `vocab_words_add`
 * over MCP. An app's name is its folder's.
 */
import { type Action, isAction } from './action.ts';
import type { AnyData } from './data.ts';

/** An app's actions, nested: a key holds an action, or a group of them under that word. */
export type Actions = { readonly [word: string]: Action | Actions };

/** An app as `defineApp` returns it: what it was given, checked. */
export type App<A extends Actions = Actions, D extends AnyData = AnyData> = {
	readonly description: string;
	/** What `defineData` returned, when the app keeps records. */
	readonly data?: D;
	/** Each action, nested under its words. */
	readonly actions: A;
};

/**
 * Define an app: its description, its data when it keeps records, and its
 * actions, `{}` for none. Each action's words are its keys in `actions`, so
 * `words: { ...data.words.actions('list', 'get', 'add'), add: learn }` gives
 * `words list` and `words get`, with `words add` replaced by `learn`. A later
 * key replaces an earlier one, as in any object. Returns `app` itself; throws
 * when it is wrong in a way its types cannot say, so `epicenter` checks an
 * app it loads by calling this again.
 */
export function defineApp<const TApp extends App>(app: TApp): TApp {
	const problems = appProblems(app);
	if (problems.length) throw new Error(problems.join('\n'));
	return app;
}

/**
 * Whether `value` is a name: lowercase letters, digits, and dashes, starting
 * with a letter. An app's folder, a data key, and each of an action's words
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
		return ['An app is an object: defineApp({ description, data, actions })'];
	const { description, data, actions } = app as Partial<App>;
	const problems: string[] = [];
	if (typeof description !== 'string' || description.trim() === '')
		problems.push('An app needs a description');
	if (data !== undefined && !isObject(data))
		problems.push('An app needs data: the value returned by defineData(...)');
	if (isObject(data)) {
		for (const [key, handle] of Object.entries(data)) {
			const name = key.replace(/\.md$/, '');
			if (!isName(name))
				problems.push(
					`data has the key ${JSON.stringify(key)}, which must be a name, optionally followed by .md`,
				);
			if (
				!isObject(handle) ||
				!isObject(handle.fields) ||
				typeof handle.get !== 'function' ||
				typeof handle.pathOf !== 'function' ||
				(key.endsWith('.md')
					? 'list' in handle && handle.list !== undefined
					: !('list' in handle) || typeof handle.list !== 'function')
			)
				problems.push(`data.${key} is not a handle from defineData(...)`);
		}
	}
	if (!isObject(actions))
		problems.push(
			'An app needs actions: an object of defineAction(...) and groups of them, {} for none',
		);
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
			else if (
				typeof entry.description === 'string' ||
				(typeof entry.run === 'function' && !isAction(entry.run))
			)
				problems.push(
					`${at} is not an action: make it with defineAction(...), and change one with defineAction({ ... }) rather than a spread, which drops the call`,
				);
			else walk(entry, [...words, word]);
		}
	};
	if (isObject(actions)) walk(actions, []);
	return problems;
}
