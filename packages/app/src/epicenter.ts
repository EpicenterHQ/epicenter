/**
 * A home's program: what its root `epicenter.ts` default-exports, and the
 * one module serve imports.
 *
 * ```ts
 * export default defineEpicenter({
 *   apps: { flights: flights(data), writing: writing(data) },
 * });
 * ```
 *
 * An app is a function of the home's `Data` that returns its description
 * and its actions. Its name is its key in `apps`: the command word
 * (`epicenter flights daily`), the MCP tool prefix (`flights_daily`) and the
 * route (`/actions/flights/daily`).
 */
import { Compile } from 'typebox/compile';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, trySync } from 'wellcrafted/result';
import type { Action } from './action.ts';
import { isPlainObject } from './json.ts';
import { isName, NAME_RULE } from './name.ts';

/** An app as its function returns it: what it is for, and each action under its name. */
export type App = {
	readonly description: string;
	readonly actions: { readonly [name: string]: Action };
};

/** A home's program: its apps, by name. */
export type Epicenter<TApps extends Record<string, App> = Record<string, App>> =
	{ readonly apps: TApps };

/**
 * Define a home's program from its apps. Serve checks the names when it
 * loads the program; an app named `serve`, the command's own word, is
 * refused by the type.
 */
export const defineEpicenter = <
	const TApps extends Record<string, App> & { serve?: never },
>({
	apps,
}: {
	apps: TApps;
}): Epicenter<TApps> => ({ apps });

/**
 * What serve refuses in what `epicenter.ts` default-exported, one sentence
 * each: no `apps` object, an app or action name that is not a name, an app
 * that is not `{ description, actions }`, an action that is not a function,
 * or an input schema TypeBox cannot compile, such as a raw `pattern` that is
 * not a regular expression. An MCP tool is `<app>_<action>`, so a name with
 * `_` would be read wrongly. Code changes only when serve restarts, so a
 * schema checked here cannot fail a call later.
 */
export function programProblems(program: unknown): string[] {
	const apps = isPlainObject(program) ? program.apps : undefined;
	if (!isPlainObject(apps))
		return ['epicenter.ts must default-export defineEpicenter({ apps })'];
	const problems: string[] = [];
	for (const [name, app] of Object.entries(apps)) {
		if (!isName(name))
			problems.push(
				`The app name ${JSON.stringify(name)} must be ${NAME_RULE}`,
			);
		const actions = isPlainObject(app) ? app.actions : undefined;
		if (!isPlainObject(actions)) {
			problems.push(
				`apps.${name} must be what its app returns: { description, actions }`,
			);
			continue;
		}
		for (const [action, run] of Object.entries(actions)) {
			if (!isName(action))
				problems.push(
					`apps.${name} has the action ${JSON.stringify(action)}, which must be ${NAME_RULE}`,
				);
			if (typeof run !== 'function') {
				problems.push(`apps.${name}.${action} must be made with defineAction`);
				continue;
			}
			const { error } = trySync({
				try: () => Compile((run as Action).input),
				catch: (cause) => Err(extractErrorMessage(cause)),
			});
			if (error !== null)
				problems.push(
					`apps.${name}.${action} has an input schema that does not compile: ${error}`,
				);
		}
	}
	return problems;
}
