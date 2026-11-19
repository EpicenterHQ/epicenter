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
import { isName, NAME_RULE } from './name.ts';

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
 * name that is not lowercase letters, digits and dashes, an app with no
 * description, and an action `defineAction` did not make. Its type refuses
 * an app named `serve`, which is the command's own word.
 */
export function defineEpicenter<
	const TApps extends Record<string, App> & { serve?: never },
>({ apps }: { apps: TApps }): Epicenter<TApps> {
	const problems = appsProblems(apps);
	if (problems.length) throw new Error(problems.join('\n'));
	return Object.freeze({ apps, [EPICENTER]: true as const });
}

/** What is wrong with `apps` beyond its types, one sentence each. */
function appsProblems(apps: Record<string, App>) {
	const problems: string[] = [];
	for (const [name, { description, actions }] of Object.entries(apps)) {
		if (!isName(name))
			problems.push(
				`The app name ${JSON.stringify(name)} must be ${NAME_RULE}`,
			);
		if (description.trim() === '')
			problems.push(`apps.${name} needs a description`);
		for (const [action, value] of Object.entries(actions)) {
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
