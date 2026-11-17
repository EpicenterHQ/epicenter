/**
 * The Epicenter, app, and action views (ADR-0841). `--json` prints the app's
 * description and data keys with each action as the MCP tool `serve`
 * offers, so a listing and `tools/list` agree; the human views come from the
 * same actions.
 */

import { basename } from 'node:path';
import { type Action, whatTakes } from '@epicenter/app';
import type { TSchemaOptions } from 'typebox';
import type { Discovery, Runnable } from './home.ts';
import {
	exampleCommand,
	jsonSchema,
	requiredKeys,
	usageLine,
} from './input.ts';
import { type RepositoryStatus, repositoryLine } from './repository.ts';
import { installNext } from './install.ts';

/**
 * An action as an MCP tool definition: its name, input schema, and the hints
 * it states. `mcp: false` marks one a listing shows and serve does not offer.
 */
export function actionTool(app: string, key: string, action: Action) {
	return {
		name: `${app}_${key.replaceAll(' ', '_')}`,
		description: action.description,
		inputSchema: jsonSchema(action.input),
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
		...(located.link ? { link: located.link } : {}),
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
								fields: jsonSchema(handle.fields),
							},
						]),
					),
				}
			: {}),
		actions: Object.entries(located.actions).map(([key, action]) =>
			actionTool(located.name, key, action),
		),
	};
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
 * The home's report: the version of Epicenter it has installed, its apps,
 * with broken entries kept apart from runnable ones, then its routines, then
 * one line about its repository. `--json` carries the same facts; `version`
 * is `null` when the home has no install, and `repository` when it is not
 * one.
 */
export function homeListing(
	found: Discovery,
	{
		routines,
		repository,
		version,
	}: {
		routines: RoutineRow[];
		repository: RepositoryStatus | null;
		version: string | null;
	},
	json: boolean,
): unknown {
	if (json)
		return {
			epicenter: found.epicenter,
			version,
			apps: found.apps.map((app) => appListing(app)),
			problems: found.problems.map(({ entry, folder, problems }) => ({
				entry,
				folder,
				problems,
			})),
			routines,
			repository,
		};
	const width = Math.max(0, ...found.apps.map(({ name }) => name.length));
	const lines = found.apps.map((located) => {
		return `${located.name.padEnd(width)}  ${located.app.description}${located.link ? ` -> ${located.link}` : ''}`;
	});
	if (!found.apps.length) lines.push('No apps yet. Run: epicenter new <name>');
	else lines.push('', 'Run: epicenter <app>');
	lines.unshift(
		`Epicenter: ${basename(found.epicenter)} (${found.epicenter})`,
		version === null
			? `Version: not installed. Run: ${installNext(found.epicenter)}`
			: `Version: ${version}`,
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
	lines.push('', `Git: ${repositoryLine(found.epicenter, repository)}`);
	return lines.join('\n');
}

/** Render an app's actions and its container folder. */
export function oneAppListing(located: Runnable, json: boolean): unknown {
	if (json) return appListing(located);
	return [
		`${located.name}  ${located.app.description}`,
		`folder: ${located.folder}`,
		...(located.link ? [`link: ${located.link}`] : []),
		'',
		...(located.app.data
			? Object.entries(located.app.data).flatMap(([key, handle]) => [
					`  ${key}  data/${key}${key.endsWith('.md') ? '' : '/'}`,
					...(handle.description ? [`    ${handle.description}`] : []),
					`    ${JSON.stringify(jsonSchema(handle.fields))}`,
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
	const keys = Object.keys(action.input);
	if (!keys.length) return usage.join('\n');
	const required = requiredKeys(action.input);
	const rows = Object.entries(action.input).map(([key, field]) => {
		const { description } = field as TSchemaOptions;
		return [
			key,
			required.has(key) ? 'required' : 'optional',
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
