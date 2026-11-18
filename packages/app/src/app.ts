/**
 * An app: what its `epicenter.ts` default-exports (ADR-0960). It is a
 * function of its folder. Whoever loads it calls it with the folder, and it
 * returns its description, its data and its actions:
 *
 * ```ts
 * import { defineAction, defineApp, defineData, field, Ok } from '@epicenter/app';
 *
 * export default defineApp(({ folder }) => {
 *   const data = defineData(folder, {
 *     words: { fields: { meaning: field.text() } },
 *   });
 *
 *   const learn = defineAction({
 *     description: 'Learn a word',
 *     input: { word: field.text(), meaning: field.text() },
 *     run: ({ word, meaning }) => data.words.create(word, { meaning }),
 *   });
 *
 *   return {
 *     description: 'Words I am learning',
 *     data,
 *     actions: { words: { ...data.words.actions('list', 'get', 'patch'), create: learn } },
 *   };
 * });
 * ```
 *
 * The actions nest as they are called: `app.actions.words.create({ word })` in
 * code, `epicenter vocab words create` on the command line, `vocab_words_create`
 * over MCP. An app's name is its folder's. Serve calls the function with the
 * app's folder; a test calls it with a folder on a temporary directory.
 *
 * An app may also return `fetch`, a web-standard handler that answers the
 * requests under its address, `/apps/<app>/`, that no built file in
 * `code/ui/dist/` answers (ADR-0945). It is for protocols someone else
 * defined: an OAuth redirect, a download, a feed, an upload. Anything a
 * person or an agent should be able to do is an action, since the command
 * line and MCP never see `fetch`.
 */
import { type Action, isAction } from './action.ts';
import type { AnyData } from './data.ts';
import type { Folder } from './folder.ts';

/** An app's actions, nested: a key holds an action, or a group of them under that word. */
export type Actions = { readonly [word: string]: Action | Actions };

/** What an app's function returns: its description, data and actions. */
export type App<A extends Actions = Actions, D extends AnyData = AnyData> = {
	readonly description: string;
	/** What `defineData` returned, when the app keeps records. */
	readonly data?: D;
	/** Each action, nested under its words. */
	readonly actions: A;
	/**
	 * Answer a web request under `/apps/<app>/` that no built file answers.
	 * Serve removes `/apps/<app>` from the URL, so `/apps/mail/oauth/callback`
	 * arrives as `/oauth/callback`, and sets `X-Forwarded-Prefix: /apps/<app>`.
	 * A Hono or Elysia app's `fetch` fits as it is.
	 */
	readonly fetch?: (request: Request) => Response | Promise<Response>;
};

/** What an app's function is called with: the one thing it is handed. */
type Given = { folder: Folder };

/**
 * Define an app as a function of its folder. The function returns the
 * app's description, its data when it keeps records, and its actions, `{}`
 * for none. Each action's words are its keys in `actions`, so
 * `words: { ...data.words.actions('list', 'get', 'create'), create: learn }`
 * gives `words list` and `words get`, with `words create` replaced by
 * `learn`. A later key replaces an earlier one, as in any object.
 *
 * Returns the function, which, when called, throws if what it returned is
 * wrong in a way its types cannot say; so `epicenter` checks an app it
 * loads by calling this again. Loading an app should not touch its files:
 * read and write inside actions.
 */
export function defineApp<const TApp extends App>(
	app: (given: Given) => TApp,
): (given: Given) => TApp {
	if (typeof app !== 'function')
		throw new Error(
			'An app is a function of its folder: defineApp(({ folder }) => ({ description, data, actions }))',
		);
	return (given) => {
		const made = app(given);
		const problems = appProblems(made);
		if (problems.length) throw new Error(problems.join('\n'));
		return made;
	};
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
		return [
			'An app returns an object: defineApp(({ folder }) => ({ description, data, actions }))',
		];
	const { description, data, actions, fetch } = app as Partial<App>;
	const problems: string[] = [];
	if (typeof description !== 'string' || description.trim() === '')
		problems.push('An app needs a description');
	if (fetch !== undefined && typeof fetch !== 'function')
		problems.push(
			"An app's fetch is a function: (request: Request) => Response | Promise<Response>",
		);
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
				typeof handle.path !== 'function' ||
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
