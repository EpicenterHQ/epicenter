/**
 * The Epicenter, app, and action views (ADR-0841). `--json` prints the app's
 * description and collections with each action as the MCP tool `serve`
 * offers, so a listing and `tools/list` agree, except that MCP leaves out an
 * action with private or file input, which the listing keeps for
 * the app's own page; the human views come from the same actions.
 */

import { basename } from 'node:path';
import { type Action, whatTakes } from '@epicenter/app';
import type { TSchemaOptions } from 'typebox';
import type { Discovery, Runnable } from './home.ts';
import {
	exampleCommand,
	jsonSchema,
	requiredKeys,
	takesFile,
	usageLine,
} from './input.ts';

/** MCP's defaults for each hint an action does not give. */
const ANNOTATION_DEFAULTS = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: true,
} as const;

/** An action as an MCP tool definition: its name, input schema, and all four hints, explicit. */
export function actionTool(app: string, key: string, action: Action) {
	return {
		name: `${app}_${key.replaceAll(' ', '_')}`,
		description: action.description,
		inputSchema: jsonSchema(action.input),
		annotations: { ...ANNOTATION_DEFAULTS, ...action.annotations },
		...(action.privateInput === true ? { privateInput: true } : {}),
	};
}

/**
 * The app as `--json` prints it: its description, each collection's path and
 * fields as JSON Schema and its actions as tools.
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
			: {
					collections: Object.fromEntries(
						Object.entries(app.collections).map(([name, collection]) => [
							name,
							{
								path: collection.path,
								...(collection.description
									? { description: collection.description }
									: {}),
								fields: jsonSchema(collection.fields),
							},
						]),
					),
				}),
		actions: Object.entries(located.actions).map(([key, action]) =>
			actionTool(located.name, key, action),
		),
	};
}

/** " (read-only)" for an action that changes nothing; the other hints are for MCP clients. */
function readOnly(action: Action) {
	return { ...ANNOTATION_DEFAULTS, ...action.annotations }.readOnlyHint
		? ' (read-only)'
		: '';
}

/** Each action as its usage line and its description; `--help` on an action lists its input's keys. */
function actionLines(located: Runnable) {
	return Object.entries(located.actions).flatMap(([key, action]) => [
		`  ${usageLine(located.name, key, action)}`,
		`    ${action.description}${readOnly(action)}`,
	]);
}

/** Render discovery as one answer while keeping broken entries separate from runnable apps. */
export function homeListing(found: Discovery, json: boolean): unknown {
	if (json)
		return {
			epicenter: found.epicenter,
			apps: found.apps.map((app) => appListing(app)),
			problems: found.problems.map(({ entry, folder, problems }) => ({
				entry,
				folder,
				problems,
			})),
		};
	const width = Math.max(0, ...found.apps.map(({ name }) => name.length));
	const lines = found.apps.map((located) => {
		return `${located.name.padEnd(width)}  ${located.app.description}${located.link ? ` -> ${located.link}` : ''}`;
	});
	if (!found.apps.length) lines.push('No apps yet. Run: epicenter new <name>');
	else lines.push('', 'Run: epicenter <app>');
	lines.unshift(`Epicenter: ${basename(found.epicenter)} (${found.epicenter})`);
	if (found.problems.length) {
		lines.push('', 'Problems:');
		for (const app of found.problems)
			lines.push(
				`  ${app.entry}`,
				`    ${app.folder}`,
				...app.problems.map((problem) => `    ${problem}`),
			);
	}
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
	if (takesFile(action))
		return [
			...usage,
			'',
			'This action takes a file. Start it from its page; the command line cannot supply it.',
		].join('\n');
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
		action.privateInput === true
			? 'Input, one JSON object read from stdin with -, never an argument:'
			: 'Input, one JSON object, or - to read it from stdin:',
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
