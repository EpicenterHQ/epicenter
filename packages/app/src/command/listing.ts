/**
 * The one listing of an Epicenter's apps (ADR-0841, ADR-0961). Serve builds
 * it from the apps it loaded and answers it at `GET /` as JSON; every view of
 * the apps prints from it:
 *
 * | Reader | What it prints |
 * | --- | --- |
 * | MCP `tools/list` | each action not marked `mcp: false` |
 * | the launcher page | each app with a UI |
 * | bare `epicenter`, `--json` | every app, its problems, and the routines |
 * | `epicenter <app>`, an action's `--help` | one app, or one action and its input |
 *
 * Each action is the MCP tool serve offers, in plain JSON, so the command
 * renders help from it without loading the app. The listing names no path
 * on this computer; the command adds the folders it knows.
 */

import { basename, join } from 'node:path';
import type { TSchemaOptions } from 'typebox';
import packageJson from '../../package.json' with { type: 'json' };
import { type ObjectSchema, objectSchema, whatTakes } from '../field.ts';
import { type Action, ActionError, type Answer, Ok } from '../index.ts';
import { discoverAll, type LoadedApp } from './home.ts';
import { exampleCommand, usageLine } from './input.ts';
import type { EpicenterRoot } from './root.ts';
import { createRoutines, type RoutineRow } from './routines.ts';

/**
 * The MCP tool name of the action `key` in `app`: the app and the action's
 * words joined by `_`. App names and action words have no underscores, so
 * `fromToolName` reads it back.
 */
export const toolName = (app: string, key: string) =>
	`${app}_${key.replaceAll(' ', '_')}`;

/** The app and action key a tool name names. */
export function fromToolName(name: string) {
	const [app = '', ...words] = name.split('_');
	return { app, key: words.join(' ') };
}

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

export function actionTool(
	app: string,
	key: string,
	action: Action,
): ActionTool {
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

/** Everything serve offers, as `GET /` answers it in JSON. */
export type Listing = {
	/** The version of `@epicenter/app` serve runs. */
	version: string;
	apps: AppListing[];
	/** Each app folder with a problem: one that did not load, or a `local/` that could reach Git. */
	problems: { entry: string; problems: string[] }[];
	routines: RoutineRow[];
};

export function appListing({ name, app, actions }: LoadedApp): AppListing {
	return {
		name,
		description: app.description,
		...(app.data
			? {
					data: Object.fromEntries(
						Object.entries(app.data).map(([key, handle]) => [
							key,
							{
								path: `data/${key}${key.endsWith('.md') ? '' : '/'}`,
								...(handle.description
									? { description: handle.description }
									: {}),
								fields: objectSchema(handle.fields),
							},
						]),
					),
				}
			: {}),
		actions: Object.entries(actions).map(([key, action]) =>
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
		problems: found.problems.map(({ name, problems }) => ({
			entry: name,
			problems,
		})),
		routines,
	};
}

/** Where the app `name` lives in the Epicenter, which the command knows and serve does not say. */
const appFolder = (root: Pick<EpicenterRoot, 'folder'>, name: string) =>
	join(root.folder, 'apps', name);

/** " (read-only)" for an action that says it changes nothing; the other hints are for MCP clients. */
function readOnly(tool: ActionTool) {
	return tool.annotations?.readOnlyHint ? ' (read-only)' : '';
}

/** " (not offered to agents)" for an action serve keeps out of its MCP tools. */
function notOffered(tool: ActionTool) {
	return tool.mcp === false ? ' (not offered to agents)' : '';
}

/**
 * The report bare `epicenter` prints: the version of Epicenter serve runs,
 * its apps, with broken ones kept apart, then its routines. `--json` carries
 * the same facts. Git reports on the Epicenter's repository itself.
 */
export function rootReport(
	listing: Listing,
	root: Pick<EpicenterRoot, 'folder'>,
	json: boolean,
): unknown {
	const { version, apps, problems, routines } = listing;
	if (json)
		return {
			epicenter: root.folder,
			version,
			apps: apps.map((app) => withFolder(app, root)),
			problems: problems.map(({ entry, problems }) => ({
				entry,
				folder: appFolder(root, entry),
				problems,
			})),
			routines,
		};
	const width = Math.max(0, ...apps.map(({ name }) => name.length));
	const lines = apps.map(
		({ name, description }) => `${name.padEnd(width)}  ${description}`,
	);
	if (!apps.length)
		lines.push('No apps yet. An app is apps/<name>/code/epicenter.ts');
	else lines.push('', 'Run: epicenter <app>');
	lines.unshift(
		`Epicenter: ${basename(root.folder)} (${root.folder})`,
		`Version: ${version}`,
	);
	if (problems.length) {
		lines.push('', 'Problems:');
		for (const { entry, problems: each } of problems)
			lines.push(
				`  ${entry}`,
				`    ${appFolder(root, entry)}`,
				...each.map((problem) => `    ${problem}`),
			);
	}
	lines.push('');
	if (!routines.length)
		lines.push('No routines. Add routines/<name>.md with cron and run.');
	else
		lines.push(
			'Routines:',
			...routines.flatMap((row) =>
				'problem' in row
					? [`  ${row.name}: ${row.problem}`]
					: [
							`  ${row.name}: cron ${row.cron}, next ${row.next ?? 'never'}`,
							`    ${row.command}`,
						],
			),
		);
	return lines.join('\n');
}

/** An app as `--json` prints it: the listing's, with its folder. */
function withFolder(
	{ name, description, ...rest }: AppListing,
	root: Pick<EpicenterRoot, 'folder'>,
) {
	return { name, description, folder: appFolder(root, name), ...rest };
}

/**
 * What `epicenter <app>` prints: the app's data keys and actions and its
 * folder. A name the listing has no app for answers `NotStarted`: its
 * problems when it did not load, else that there is no such app.
 */
export function appReport(
	listing: Listing,
	root: Pick<EpicenterRoot, 'folder'>,
	name: string,
	json: boolean,
): Answer {
	const app = listing.apps.find((each) => each.name === name);
	if (!app) {
		const broken = listing.problems.find(({ entry }) => entry === name);
		if (broken)
			return ActionError.NotStarted({
				cause: 'app-problems',
				message: `${name}: ${broken.problems.join('; ')}`,
				app: name,
				problems: broken.problems,
			});
		return ActionError.NotStarted({
			cause: 'usage',
			message: `Unknown app "${name}"`,
			next: 'epicenter',
		});
	}
	if (json) return Ok(withFolder(app, root));
	return Ok(
		[
			`${app.name}  ${app.description}`,
			`folder: ${appFolder(root, app.name)}`,
			'',
			...Object.entries(app.data ?? {}).flatMap(([key, each]) => [
				`  ${key}  ${each.path}`,
				...(each.description ? [`    ${each.description}`] : []),
				`    ${JSON.stringify(each.fields)}`,
			]),
			...app.actions.flatMap((tool) => [
				`  ${usageLine(app.name, fromToolName(tool.name).key, tool.inputSchema)}`,
				`    ${tool.description}${readOnly(tool)}${notOffered(tool)}`,
			]),
			'',
			`Run: epicenter ${app.name} <action> --help`,
		].join('\n'),
	);
}

/**
 * Explain an action's input from its tool: each key, whether it is needed,
 * what it takes, and its description, then one command to copy.
 */
export function actionHelp(tool: ActionTool): string {
	const { app, key } = fromToolName(tool.name);
	const input = tool.inputSchema;
	const usage = [usageLine(app, key, input), tool.description];
	const { properties, required } = input;
	const keys = Object.keys(properties);
	if (!keys.length) return usage.join('\n');
	const rows = Object.entries(properties).map(([key, field]) => {
		const { description } = field as TSchemaOptions;
		return [
			key,
			required.includes(key) ? 'required' : 'optional',
			`${whatTakes(field)}${description ? `. ${description}` : ''}`,
		] as const;
	});
	const width = Math.max(...keys.map((key) => key.length));
	return [
		...usage,
		'',
		'Input, one JSON object, or - to read it from stdin:',
		...rows.map(
			([key, status, text]) => `  ${key.padEnd(width)}  ${status}  ${text}`,
		),
		'',
		'Example:',
		...exampleCommand(app, key, input)
			.split('\n')
			.map((line) => `  ${line}`),
	].join('\n');
}
