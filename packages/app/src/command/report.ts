/**
 * How the `epicenter` command prints serve's listing (`listing.ts`): bare
 * `epicenter`, `epicenter <app>`, an action's `--help`, and the refusal for
 * an action an app does not have. It reads only the listing's plain JSON, so
 * the command never imports the code that loads apps.
 */

import { basename } from 'node:path';
import type { TSchemaOptions } from 'typebox';
import type { Result } from 'wellcrafted/result';
import { whatTakes } from '../field.ts';
import {
	ActionError,
	type Answer,
	Err,
	type NotStarted,
	Ok,
} from '../index.ts';

import { exampleCommand, noSuchAction, usageLine } from './input.ts';
import type {
	ActionTool,
	AppListing,
	AppProblems,
	Listing,
} from './protocol.ts';
import { appProblems, fromToolName, toolName, unknownApp } from './protocol.ts';
import { appPath, type EpicenterRoot } from './root.ts';

/** Each app's problems as `--json` prints them, with the folder serve does not say. */
export function withFolders(
	root: Pick<EpicenterRoot, 'folder'>,
	problems: AppProblems[],
) {
	return problems.map(({ entry, problems }) => ({
		entry,
		folder: appPath(root, entry),
		problems,
	}));
}

/** The `Problems:` block a report prints after its apps: each app, its folder, and its problems. */
export function problemLines(
	root: Pick<EpicenterRoot, 'folder'>,
	problems: AppProblems[],
): string[] {
	return [
		'Problems:',
		...problems.flatMap(({ entry, problems }) => [
			`  ${entry}`,
			`    ${appPath(root, entry)}`,
			...problems.map((problem) => `    ${problem}`),
		]),
	];
}

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
			problems: withFolders(root, problems),
			routines,
		};
	const width = Math.max(0, ...apps.map(({ name }) => name.length));
	const lines = apps.map(
		(app) => `${app.name.padEnd(width)}  ${app.description}`,
	);
	if (!apps.length)
		lines.push('No apps yet. An app is apps/<name>/code/epicenter.ts');
	else lines.push('', 'Run: epicenter <app>');
	lines.unshift(
		`Epicenter: ${basename(root.folder)} (${root.folder})`,
		`Version: ${version}`,
	);
	if (problems.length) lines.push('', ...problemLines(root, problems));
	lines.push('');
	if (!routines.length)
		lines.push('No routines. Add routines/<name>.md with cron and action.');
	else
		lines.push(
			'Routines:',
			...routines.flatMap((row) =>
				'problem' in row
					? [`  ${row.name}: ${row.problem}`]
					: [
							`  ${row.name}: cron ${row.cron}, next ${row.next ?? 'never'}`,
							`    ${[row.app, row.action, ...(Object.keys(row.input).length ? [JSON.stringify(row.input)] : [])].join(' ')}`,
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
	return { name, description, folder: appPath(root, name), ...rest };
}

/**
 * The app `name` in the listing. A name it has no app for answers
 * `NotStarted`: its problems when it did not load, else that there is no
 * such app.
 */
function listedApp(
	listing: Listing,
	name: string,
): Result<AppListing, NotStarted> {
	const app = listing.apps.find((each) => each.name === name);
	if (app) return Ok(app);
	const broken = listing.problems.find(({ entry }) => entry === name);
	return broken ? appProblems(name, broken.problems) : unknownApp(name);
}

/** What `epicenter <app>` prints: the app's data keys and actions and its folder. */
export function appReport(
	listing: Listing,
	root: Pick<EpicenterRoot, 'folder'>,
	name: string,
	json: boolean,
): Answer {
	const { data: app, error } = listedApp(listing, name);
	if (error) return Err(error);
	if (json) return Ok(withFolder(app, root));
	return Ok(
		[
			`${app.name}  ${app.description}`,
			`folder: ${appPath(root, app.name)}`,
			'',
			...Object.entries(app.data ?? {}).flatMap(([key, each]) => [
				`  ${key}  ${each.path}`,
				...(each.description ? [`    ${each.description}`] : []),
				`    ${JSON.stringify(each.fields)}`,
			]),
			...app.actions.flatMap((tool) => [
				`  ${usageLine(app.name, fromToolName(tool.name).action, tool.inputSchema)}`,
				`    ${tool.description}${readOnly(tool)}${notOffered(tool)}`,
			]),
			'',
			`Run: epicenter ${app.name} <action> --help`,
		].join('\n'),
	);
}

/**
 * What `epicenter <app> <action> --help` prints: the action's tool, or its
 * help as a person reads it. An action the app does not have is refused as
 * serve refuses a call to one, listing those it has.
 */
export function helpReport(
	listing: Listing,
	name: string,
	key: string,
	json: boolean,
): Answer {
	const { data: app, error } = listedApp(listing, name);
	if (error) return Err(error);
	const tool = app.actions.find((each) => each.name === toolName(name, key));
	if (!tool) return missingAction(listing, name, key);
	return Ok(json ? tool : actionHelp(tool));
}

/**
 * The command's answer for an action `name` does not have: serve's
 * refusal, then the app's actions from the listing, one line each, so a
 * person sees what to type.
 */
export function missingAction(
	listing: Listing,
	name: string,
	key: string,
): Answer {
	const { data: app, error } = listedApp(listing, name);
	if (error) return Err(error);
	return ActionError.NotStarted({
		cause: 'usage',
		message: [
			`${noSuchAction(name, key)}. Its actions:`,
			...app.actions.map((tool) =>
				usageLine(name, fromToolName(tool.name).action, tool.inputSchema),
			),
		].join('\n'),
		next: `epicenter ${name}`,
	});
}

/**
 * Explain an action's input from its tool: each key, whether it is needed,
 * what it takes, and its description, then one command to copy.
 */
export function actionHelp(tool: ActionTool): string {
	const { app, action: key } = fromToolName(tool.name);
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
