/**
 * The one listing of an Epicenter's apps (ADR-0841, ADR-0961). Serve builds
 * it from the apps it loaded and answers it at `GET /actions/`; every view of
 * the apps prints from it:
 *
 * | Reader | What it prints |
 * | --- | --- |
 * | MCP `tools/list` | each action not marked `mcp: false` |
 * | the launcher page | each app with a built page |
 * | bare `epicenter`, `--json` | every app, its problems, and the routines |
 * | `epicenter <app>`, an action's `--help` | one app, or one action and its input |
 *
 * Each action is the MCP tool serve offers, in plain JSON, so the command
 * renders help from it without loading the app. This file builds the listing
 * and loads apps to do it, so only serve imports it; the command prints the
 * listing with `report.ts`. Serve hides this computer's folders in the
 * listing's problems (`hide-paths.ts`); the command adds the folders it knows.
 */

import packageJson from '../../package.json' with { type: 'json' };
import { type ObjectSchema, objectSchema } from '../field.ts';
import type { Action } from '../index.ts';
import { type AppProblems, discoverAll, type LoadedApp } from './apps.ts';
import { toolName } from './protocol.ts';
import type { EpicenterRoot } from './root.ts';
import { createRoutines, type RoutineRow } from './routines.ts';

/**
 * An action as an MCP tool definition: its name, input schema, and the hints
 * it states. `mcp: false` marks one a listing shows and serve does not offer.
 */
export type ActionTool = {
	name: string;
	description: string;
	inputSchema: ObjectSchema;
	annotations?: Action['annotations'];
	mcp?: false;
};

function actionTool(app: string, key: string, action: Action): ActionTool {
	return {
		name: toolName(app, key),
		description: action.description,
		inputSchema: action.input,
		...(action.annotations ? { annotations: action.annotations } : {}),
		...(action.mcp === false ? { mcp: false as const } : {}),
	};
}

/** An app as the listing carries it: its description, each data key's path and fields as JSON Schema, and its actions as tools. */
export type AppListing = {
	name: string;
	description: string;
	data?: Record<
		string,
		{ path: string; description?: string; fields: ObjectSchema }
	>;
	actions: ActionTool[];
};

/** Everything serve offers, as `GET /actions/` answers it. */
export type Listing = {
	/** The version of `@epicenter/app` serve runs. */
	version: string;
	apps: AppListing[];
	/** Each app folder with a problem: one that did not load, or a `local/` that could reach Git. */
	problems: AppProblems[];
	routines: RoutineRow[];
};

export function appListing({ name, app }: LoadedApp): AppListing {
	return {
		name,
		description: app.description,
		...(app.data
			? {
					data: Object.fromEntries(
						Object.entries(app.data).map(([key, handle]) => [
							key,
							{
								path: `data/${key}/`,
								description: handle.description,
								fields: objectSchema(handle.fields),
							},
						]),
					),
				}
			: {}),
		actions: Object.entries(app.actions).map(([key, action]) =>
			actionTool(name, key, action),
		),
	};
}

/** Serve's listing: each app as it loads now, the problems of those that do not, and the routines. */
export async function listApps(
	root: Pick<EpicenterRoot, 'folder'>,
): Promise<Listing> {
	const [found, routines] = await Promise.all([
		discoverAll(root),
		createRoutines(root).list(),
	]);
	return {
		version: packageJson.version,
		apps: found.apps.map(appListing),
		problems: found.problems,
		routines,
	};
}
