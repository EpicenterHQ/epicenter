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
import type { Action } from './action.ts';

/** An app as its function returns it: what it is for, and each action under its name. */
export type App = {
	readonly description: string;
	readonly actions: { readonly [name: string]: Action };
};

/** One scheduled call, with the input of its named action. */
type Schedule<TApps extends Record<string, App>> = {
	[AppName in keyof TApps & string]: {
		[ActionName in keyof TApps[AppName]['actions'] & string]: {
			readonly cron: string;
			readonly action: readonly [AppName, ActionName];
			readonly input: Parameters<TApps[AppName]['actions'][ActionName]>[0];
		};
	}[keyof TApps[AppName]['actions'] & string];
}[keyof TApps & string];

/** A home's program: its apps and scheduled calls, by name. */
export type Epicenter<TApps extends Record<string, App> = Record<string, App>> =
	{
		readonly apps: TApps;
		readonly schedules?: Readonly<
			Record<
				string,
				{
					readonly cron: string;
					readonly action: readonly [string, string];
					readonly input: unknown;
				}
			>
		>;
	};

/**
 * Define a home's program from its apps. Serve checks the names when it
 * loads the program; an app named `serve`, the command's own word, is
 * refused by the type.
 */
export const defineEpicenter = <
	const TApps extends Record<string, App> & { serve?: never },
>({
	apps,
	schedules,
}: {
	apps: TApps;
	schedules?: Readonly<Record<string, Schedule<NoInfer<TApps>>>>;
}): Epicenter<TApps> =>
	schedules === undefined ? { apps } : { apps, schedules };
