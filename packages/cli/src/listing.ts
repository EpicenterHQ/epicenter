/**
 * The Epicenter, app, and action views (ADR-0841). `--json` prints the app's
 * description and collections with each action as the MCP tool `serve`
 * offers, so a listing and `tools/list` agree; the human views come from the
 * same actions.
 */

import { basename } from 'node:path';
import type { Action } from '@epicenter/app';
import type { TSchemaOptions } from 'typebox';
import type { Discovery, Runnable } from './home.ts';
import {
	fieldKind,
	flagOf,
	jsonSchema,
	requiredKeys,
	usageLine,
} from './input.ts';
import { epicenterRoot } from './root.ts';
import { keychainService } from './secrets.ts';
import type { statusOf } from './snapshot.ts';

/** Git's pending and unpushed counts; `undefined` for a folder in no repository. */
type Status = Awaited<ReturnType<typeof statusOf>>;

/**
 * Git-derived status as `--json` gives it: pending paths and commits not
 * backed up; absent when both counts are zero.
 */
function historyStatus(status: Status) {
	if (!status || (status.pending === 0 && !status.unpushed)) return {};
	return {
		history: {
			pending: status.pending,
			...(status.unpushed !== undefined ? { unpushed: status.unpushed } : {}),
		},
	};
}

/** An app's history status in a few words for the Epicenter listing, or nothing. */
function historyMark(status: Status) {
	const marks = [
		...(status?.pending
			? [
					`${status.pending} ${status.pending === 1 ? 'change' : 'changes'} not in history`,
				]
			: []),
		...(status?.unpushed
			? [
					`${status.unpushed} ${status.unpushed === 1 ? 'snapshot' : 'snapshots'} not backed up`,
				]
			: []),
	];
	return marks.length ? ` (${marks.join('; ')})` : '';
}

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
	};
}

/**
 * The app as `--json` prints it: its description, each collection's path and
 * fields as JSON Schema, its actions as tools, and what is not yet in its
 * history, which the caller reads from Git.
 */
function appListing(located: Runnable, history: Status) {
	const { app } = located;
	return {
		name: located.name,
		description: app.description,
		folder: located.folder,
		...(located.link ? { link: located.link } : {}),
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
		actions: Object.entries(located.actions).map(([key, action]) =>
			actionTool(located.name, key, action),
		),
		...historyStatus(history),
	};
}

/** " (read-only)" for an action that changes nothing; the other hints are for MCP clients. */
function readOnly(action: Action) {
	return { ...ANNOTATION_DEFAULTS, ...action.annotations }.readOnlyHint
		? ' (read-only)'
		: '';
}

/** Each action as one short usage line and its description; `--help` on an action gives every flag. */
function actionLines(located: Runnable) {
	return Object.entries(located.actions).flatMap(([key, action]) => [
		`  ${usageLine(located.name, key, action, { short: true })}`,
		`    ${action.description}${readOnly(action)}`,
	]);
}

/** Render discovery as one answer while keeping broken entries separate from runnable apps; an app with changes not in history is marked. */
export function homeListing(
	found: Discovery,
	json: boolean,
	histories: ReadonlyMap<string, Status>,
): unknown {
	if (json)
		return {
			epicenter: found.epicenter,
			apps: found.apps.map((app) => appListing(app, histories.get(app.name))),
			problems: found.problems.map(({ entry, folder, problems }) => ({
				entry,
				folder,
				problems,
			})),
		};
	const width = Math.max(0, ...found.apps.map(({ name }) => name.length));
	const lines = found.apps.map(
		(located) =>
			`${located.name.padEnd(width)}  ${located.app.description}${located.link ? ` -> ${located.link}` : ''}${historyMark(histories.get(located.name))}`,
	);
	if (!found.apps.length) lines.push('No apps yet. Run: epicenter new <name>');
	else lines.push('', 'Run: epicenter <app>');
	for (const app of found.apps)
		if (histories.get(app.name)?.pending || histories.get(app.name)?.unpushed)
			lines.push(`Run: epicenter sync ${app.name}`);
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

/** Render an app's actions, its folder, and what is not yet in its history; `--json` adds its keychain service. */
export function oneAppListing(
	located: Runnable,
	json: boolean,
	history: Status,
): unknown {
	if (json)
		return {
			...appListing(located, history),
			keychain: keychainService(epicenterRoot().id, located.name),
		};
	return [
		`${located.name}  ${located.app.description}`,
		`folder: ${located.folder}`,
		...(located.link ? [`link: ${located.link}`] : []),
		...(history?.pending
			? [
					`${history.pending} ${history.pending === 1 ? 'change' : 'changes'} not yet in history`,
				]
			: []),
		...(history?.unpushed
			? [
					`${history.unpushed} ${history.unpushed === 1 ? 'snapshot' : 'snapshots'} not backed up`,
				]
			: []),
		...(history?.pending || history?.unpushed
			? [`Run: epicenter sync ${located.name}`]
			: []),
		'',
		...actionLines(located),
		'',
		`Run: epicenter ${located.name} <action> --help`,
	].join('\n');
}

/**
 * Explain each field: how it is spelled, whether it is needed, and its
 * description. A positional field may also be given as its flag.
 */
export function actionHelp(name: string, key: string, action: Action): string {
	const positional = new Set<string>(action.positional ?? []);
	const required = requiredKeys(action.input);
	const rows = Object.entries(action.input).map(([key, field]) => {
		const schema = field as TSchemaOptions;
		const kind = fieldKind(schema);
		const flag = `--${flagOf(key)}`;
		const asFlag = kind === 'switch' ? flag : `${flag} <${kind}>`;
		const spelling = positional.has(key) ? `<${key}>, ${asFlag}` : asFlag;
		const status = Object.hasOwn(schema, 'default')
			? `default ${JSON.stringify(schema.default)}`
			: required.has(key)
				? 'required'
				: 'optional';
		return [
			spelling,
			`${status}.${schema.description ? ` ${schema.description}` : ''}`,
		] as const;
	});
	const width = Math.max(0, ...rows.map(([spelling]) => spelling.length));
	return [
		usageLine(name, key, action),
		action.description,
		'',
		...rows.map(([spelling, text]) => `  ${spelling.padEnd(width)}  ${text}`),
	].join('\n');
}
