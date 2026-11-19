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
import { type Action, isAction } from './action.ts';
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
 * Define a home's program from its apps. Throws, naming each problem, for a
 * name that is not lowercase letters, digits and dashes, an app named
 * `serve` (the command's own word, which its type refuses too), an app with
 * no description, and an action `defineAction` did not make.
 */
export function defineEpicenter<
	const TApps extends Record<string, App> & { serve?: never },
>({ apps }: { apps: TApps }): Epicenter<TApps> {
	const problems = programProblems({ apps });
	if (problems.length) throw new Error(problems.join('\n'));
	return Object.freeze({ apps });
}

/**
 * What is wrong with `program` as a home's program, one sentence each:
 * `defineEpicenter` throws them, and serve checks what it imported with
 * them, so a program serve runs is one `defineEpicenter` would accept.
 */
export function programProblems(program: unknown): string[] {
	const apps = isPlainObject(program) ? program.apps : undefined;
	if (!isPlainObject(apps))
		return ['epicenter.ts must default-export defineEpicenter({ apps })'];
	const problems: string[] = [];
	for (const [name, app] of Object.entries(apps)) {
		if (!isName(name) || name === 'serve')
			problems.push(
				`The app name ${JSON.stringify(name)} must be ${NAME_RULE}, and not serve`,
			);
		if (!isPlainObject(app) || !isPlainObject(app.actions)) {
			problems.push(`apps.${name} must be { description, actions }`);
			continue;
		}
		if (typeof app.description !== 'string' || app.description.trim() === '')
			problems.push(`apps.${name} needs a description`);
		for (const [action, value] of Object.entries(app.actions)) {
			if (!isName(action))
				problems.push(
					`apps.${name} has the action ${JSON.stringify(action)}, which must be ${NAME_RULE}`,
				);
			else if (!isAction(value))
				problems.push(
					`apps.${name}.actions.${action} is not an action: make it with defineAction(...)`,
				);
		}
	}
	return problems;
}
