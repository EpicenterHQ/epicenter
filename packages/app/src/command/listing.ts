/**
 * The Epicenter, app, and action views (ADR-0841). `--json` prints the app's
 * description and data keys with each action as the MCP tool `serve`
 * offers, so a listing and `tools/list` agree; the human views come from the
 * same actions.
 */

import { basename } from 'node:path';
import type { TSchemaOptions } from 'typebox';
import packageJson from '../../package.json' with { type: 'json' };
import { whatTakes } from '../field.ts';
import { type Action, objectSchema } from '../index.ts';
import type { Discovery, Runnable } from './home.ts';
import { exampleCommand, usageLine } from './input.ts';

/**
 * An action as an MCP tool definition: its name, input schema, and the hints
 * it states. `mcp: false` marks one a listing shows and serve does not offer.
 */
export function actionTool(app: string, key: string, action: Action) {
	return {
		name: `${app}_${key.replaceAll(' ', '_')}`,
		description: action.description,
		inputSchema: action.input,
		...(action.annotations ? { annotations: action.annotations } : {}),
		...(action.mcp === false ? { mcp: false as const } : {}),
	};
}

/**
 * The app as `--json` prints it: its description, each data key's path and
 * fields as JSON Schema, and its actions as tools.
 */
function appListing(located: Runnable) {
	const { app } = located;
	return {
		name: located.name,
		description: app.description,
		folder: located.folder,
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
		actions: Object.entries(located.actions).map(([key, action]) =>
			actionTool(located.name, key, action),
		),
		// Its fetch routes are not listed: only that the app answers web requests (ADR-0945).
		...(app.fetch ? { fetch: true as const } : {}),
	};
}

/** " (answers web requests)" for an app that returned `fetch`, whose routes no listing shows. */
function answersWeb(located: Runnable) {
	return located.app.fetch ? ' (answers web requests)' : '';
}

/** " (read-only)" for an action that says it changes nothing; the other hints are for MCP clients. */
function readOnly(action: Action) {
	return action.annotations?.readOnlyHint ? ' (read-only)' : '';
}

/** " (not offered to agents)" for an action serve keeps out of its MCP tools. */
function notOffered(action: Action) {
	return action.mcp === false ? ' (not offered to agents)' : '';
}

/** Each action as its usage line and its description; `--help` on an action lists its input's keys. */
function actionLines(located: Runnable) {
	return Object.entries(located.actions).flatMap(([key, action]) => [
		`  ${usageLine(located.name, key, action)}`,
		`    ${action.description}${readOnly(action)}${notOffered(action)}`,
	]);
}

/** A routine as the report shows it: its schedule, next occurrence, and command to copy into a terminal, or why its file is refused. */
export type RoutineRow =
	| { name: string; cron: string; next: string | undefined; command: string }
	| { name: string; problem: string };

/**
 * The home's report: the version of Epicenter running it, its apps, with
 * broken entries kept apart from runnable ones, then its routines. `--json`
 * carries the same facts. Git reports on the home's repository itself.
 */
export function homeListing(
	found: Discovery,
	routines: RoutineRow[],
	json: boolean,
): unknown {
	if (json)
		return {
			epicenter: found.epicenter,
			version: packageJson.version,
			apps: found.apps.map((app) => appListing(app)),
			problems: found.problems.map(({ entry, folder, problems }) => ({
				entry,
				folder,
				problems,
			})),
			routines,
		};
	const width = Math.max(0, ...found.apps.map(({ name }) => name.length));
	const lines = found.apps.map((located) => {
		return `${located.name.padEnd(width)}  ${located.app.description}${answersWeb(located)}`;
	});
	if (!found.apps.length)
		lines.push('No apps yet. An app is apps/<name>/code/epicenter.ts');
	else lines.push('', 'Run: epicenter <app>');
	lines.unshift(
		`Epicenter: ${basename(found.epicenter)} (${found.epicenter})`,
		`Version: ${packageJson.version}`,
	);
	if (found.problems.length) {
		lines.push('', 'Problems:');
		for (const app of found.problems)
			lines.push(
				`  ${app.entry}`,
				`    ${app.folder}`,
				...app.problems.map((problem) => `    ${problem}`),
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

/** Render an app's actions and its container folder. */
export function oneAppListing(located: Runnable, json: boolean): unknown {
	if (json) return appListing(located);
	return [
		`${located.name}  ${located.app.description}${answersWeb(located)}`,
		`folder: ${located.folder}`,
		'',
		...(located.app.data
			? Object.entries(located.app.data).flatMap(([key, handle]) => [
					`  ${key}  data/${key}${key.endsWith('.md') ? '' : '/'}`,
					...(handle.description ? [`    ${handle.description}`] : []),
					`    ${JSON.stringify(objectSchema(handle.fields))}`,
				])
			: []),
		...actionLines(located),
		'',
		`Run: epicenter ${located.name} <action> --help`,
	].join('\n');
}

/**
 * Explain an action's input: each key, whether it is needed, what it takes,
 * and its description, then one command to copy.
 */
export function actionHelp(name: string, key: string, action: Action): string {
	const usage = [usageLine(name, key, action), action.description];
	const { properties, required } = action.input;
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
		...exampleCommand(name, key, action)
			.split('\n')
			.map((line) => `  ${line}`),
	].join('\n');
}
