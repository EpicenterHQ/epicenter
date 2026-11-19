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
