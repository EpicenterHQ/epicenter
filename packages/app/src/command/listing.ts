/**
 * The one listing of an Epicenter's apps (ADR-0841, ADR-0961). Serve builds
 * it from the apps it loaded at start and answers it at `GET /actions/`;
 * every view of the apps prints from it:
 *
 * | Reader | What it prints |
 * | --- | --- |
 * | MCP `tools/list` | each action not marked `mcp: false` |
 * | the launcher page | each app with a built page |
 * | bare `epicenter`, `--json` | every app, its problems, and the routines |
 * | `epicenter <app>`, an action's `--help` | one app, or one action and its input |
 *
 * Each action is the MCP tool serve offers, in plain JSON, so the command
 * renders help from it without loading the app. The listing's types are in
 * `protocol.ts`, which the command reads; only serve imports this file.
 */

import packageJson from '../../package.json' with { type: 'json' };
import { objectSchema } from '../field.ts';
import type { App } from '../index.ts';
import type { Apps } from './apps.ts';
import {
	type ActionTool,
	type AppListing,
	type AppProblems,
	type Listing,
	toolName,
} from './protocol.ts';

/** The app `name` as the listing carries it. */
export function appListing(name: string, app: App): AppListing {
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
		actions: Object.entries(app.actions).map(
			([action, defined]): ActionTool => ({
				name: toolName(name, action),
				description: defined.description,
				inputSchema: defined.input,
				...(defined.annotations ? { annotations: defined.annotations } : {}),
				...(defined.mcp === false ? { mcp: false as const } : {}),
			}),
		),
	};
}

/** The listing of `apps` as serve loaded them, without the routines. */
export function listApps(apps: Apps): Omit<Listing, 'routines'> {
	const entries = [...apps.values()];
	return {
		version: packageJson.version,
		apps: entries.flatMap(({ name, app }) =>
			app ? [appListing(name, app)] : [],
		),
		problems: entries.flatMap(({ name, problems }): AppProblems[] =>
			problems.length ? [{ entry: name, problems }] : [],
		),
	};
}
