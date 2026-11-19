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
import { isName } from './name.ts';
import { isPlainObject } from './result.ts';

/** An app as its function returns it: what it is for, and each action under its name. */
export type App = {
	readonly description: string;
	readonly actions: { readonly [name: string]: Action };
};

/** Marks what `defineEpicenter` made. Registered, so serve knows it whichever copy of this package made it. */
const EPICENTER: unique symbol = Symbol.for('epicenter.home');

/** A home's program: its apps, by name. */
export type Epicenter<TApps extends Record<string, App> = Record<string, App>> =
	{
		readonly apps: TApps;
		readonly [EPICENTER]: true;
	};

/** Whether `value` is what `defineEpicenter` returned. */
export function isEpicenter(value: unknown): value is Epicenter {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { [EPICENTER]?: unknown })[EPICENTER] === true
	);
}

/**
 * Define a home's program from its apps. Throws, naming each problem, for a
 * name that is not lowercase letters, digits and dashes, for an app named
 * `serve`, which is the command's own word, and for an app or action that is
 * not one.
 */
export function defineEpicenter<
	const TApps extends Record<string, App> & { serve?: never },
>({ apps }: { apps: TApps }): Epicenter<TApps> {
	const problems = appsProblems(apps);
	if (problems.length) throw new Error(problems.join('\n'));
	return Object.freeze({ apps, [EPICENTER]: true as const });
}

const NAMED = 'lowercase letters, digits and dashes, starting with a letter';

/** What is wrong with `apps` beyond its types, one sentence each. */
function appsProblems(apps: unknown): string[] {
	if (!isPlainObject(apps))
		return [
			'defineEpicenter takes { apps }, an object of each app by its name',
		];
	const problems: string[] = [];
	for (const [name, app] of Object.entries(apps)) {
		if (name === 'serve')
			problems.push(
				'An app cannot be named serve: epicenter serve is the command that runs the home',
			);
		else if (!isName(name))
			problems.push(`The app name ${JSON.stringify(name)} must be ${NAMED}`);
		if (!isPlainObject(app)) {
			problems.push(
				`apps.${name} is not an app: an app's function returns { description, actions }`,
			);
			continue;
		}
		const { description, actions } = app;
		if (typeof description !== 'string' || description.trim() === '')
			problems.push(`apps.${name} needs a description`);
		if (!isPlainObject(actions)) {
			problems.push(
				`apps.${name} needs actions: an object of defineAction(...), {} for none`,
			);
			continue;
		}
		for (const [action, value] of Object.entries(actions)) {
			if (!isName(action))
				problems.push(
					`apps.${name} has the action ${JSON.stringify(action)}, which must be ${NAMED}`,
				);
			else if (!isAction(value))
				problems.push(
					`apps.${name}.actions.${action} is not an action: make it with defineAction(...)`,
				);
		}
	}
	return problems;
}
