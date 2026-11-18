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
 *     words: { description: 'word', fields: { meaning: field.text() } },
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
 *     actions: { ...data.words.actions('list', 'get', 'patch'), learn },
 *   };
 * });
 * ```
 *
 * Each action has one name, its key: `app.actions.learn({ word, meaning })` in
 * code, `epicenter vocab learn` on the command line, `vocab_learn` over MCP,
 * `POST /actions/vocab/learn` from a page. An app's name is its folder's. Serve calls the function with the
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
import { isPlainObject } from './action-result.ts';
import type { AnyData } from './data.ts';
import type { Folder } from './folder.ts';

/** An app's actions, each under its one name. */
export type Actions = { readonly [name: string]: Action };

/** What an app's function returns: its description, data and actions. */
export type App = {
	readonly description: string;
	/** What `defineData` returned, when the app keeps records. */
	readonly data?: AnyData;
	/** Each action under its name. */
	readonly actions: Actions;
	/**
	 * Answer a web request under `/apps/<app>/` that no built file answers.
	 * The request arrives as it was sent, whole path included: the app's
	 * address is `/apps/` and its folder's name, so a Hono app is
	 * `new Hono({ strict: false }).basePath('/apps/mail')`, and its `fetch`
	 * fits as it is.
	 */
	readonly fetch?: (request: Request) => Response | Promise<Response>;
};

/** What an app's function is called with: the one thing it is handed. */
type Given = { folder: Folder };

/**
 * Define an app as a function of its folder. The function returns the
 * app's description, its data when it keeps records, and its actions, `{}`
 * for none. Each action's name is its key in `actions`, so
 * `{ ...data.words.actions('list', 'get', 'create'), create: learn }` gives
 * `list` and `get`, with `create` replaced by `learn`. A later key replaces
 * an earlier one, as in any object.
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
 * with a letter. An app's folder, a data key, and an action are named so.
 */
export function isName(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
}

const notName =
	'which is not lowercase letters, digits, and dashes, starting with a letter';

/** What is wrong with `app` beyond its types, one sentence each. */
function appProblems(app: unknown): string[] {
	if (!isPlainObject(app))
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
	if (data !== undefined && !isPlainObject(data))
		problems.push('An app needs data: the value returned by defineData(...)');
	if (isPlainObject(data)) {
		for (const [key, handle] of Object.entries(data)) {
			if (!isName(key))
				problems.push(
					`data has the key ${JSON.stringify(key)}, which must be a name`,
				);
			if (
				!isPlainObject(handle) ||
				!isPlainObject(handle.fields) ||
				typeof handle.get !== 'function' ||
				typeof handle.path !== 'function' ||
				typeof handle.list !== 'function'
			)
				problems.push(`data.${key} is not a handle from defineData(...)`);
		}
	}
	if (!isPlainObject(actions))
		problems.push(
			'An app needs actions: an object of defineAction(...), {} for none',
		);
	if (isPlainObject(actions))
		for (const [name, entry] of Object.entries(actions)) {
			const at = `actions.${name}`;
			if (!isName(name))
				problems.push(
					`actions has the key ${JSON.stringify(name)}, ${notName}`,
				);
			else if (isAction(entry)) continue;
			else if (
				isPlainObject(entry) &&
				(typeof (entry as { description?: unknown }).description === 'string' ||
					(typeof (entry as { run?: unknown }).run === 'function' &&
						!isAction((entry as { run?: unknown }).run)))
			)
				problems.push(
					`${at} is not an action: make it with defineAction(...), and change one with defineAction({ ... }) rather than a spread, which drops the call`,
				);
			else
				problems.push(
					`${at} is not an action: each action has one name, such as actions: { 'create-word': createWord }`,
				);
		}
	return problems;
}
