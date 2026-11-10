/**
 * The Epicenter, app, and action views (ADR-0841, ADR-0857). `--json` prints the
 * declaration with each action as the MCP tool `serve` offers, so a listing
 * and `tools/list` agree; the human views come from the same actions.
 */
import { type Action, ANNOTATION_DEFAULTS } from '@epicenter/app';
import { basename } from 'node:path';
import type { TSchemaOptions } from 'typebox';
import type { Discovery, Runnable } from './home.ts';
import {
	fieldKind,
	flagOf,
	jsonSchema,
	requiredKeys,
	usageLine,
} from './input.ts';
import { keychainService } from './secrets.ts';
import { epicenterRoot } from './root.ts';

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
 * The app as `--json` prints it: its declaration from `epicenter.json` and
 * its actions as tools. Nothing here reads Git (ADR-0851).
 */
function appListing(located: Runnable) {
	const { declaration } = located;
	return {
		name: located.name,
		description: declaration.description,
		folder: located.folder,
		...(located.link ? { link: located.link } : {}),
		collections: declaration.collections ?? {},
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

/** Each action as one short usage line and its description; `--help` on an action gives every flag. */
function actionLines(located: Runnable) {
	return Object.entries(located.actions).flatMap(([key, action]) => [
		`  ${usageLine(located.name, key, action, { short: true })}`,
		`    ${action.description}${readOnly(action)}`,
	]);
}

/** Render discovery as one answer while keeping broken entries separate from runnable apps. */
export function homeListing(found: Discovery, json: boolean): unknown {
	if (json)
		return {
			epicenter: found.epicenter,
			apps: found.apps.map(appListing),
			problems: found.problems.map(({ entry, folder, problems }) => ({
				entry,
				folder,
				problems,
			})),
		};
	const width = Math.max(0, ...found.apps.map(({ name }) => name.length));
	const lines = found.apps.map(
		(located) =>
			`${located.name.padEnd(width)}  ${located.declaration.description}${located.link ? ` -> ${located.link}` : ''}`,
	);
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

/** Render an app's actions and its folder; `--json` adds its keychain service. */
export function oneAppListing(located: Runnable, json: boolean): unknown {
	if (json)
		return {
			...appListing(located),
			keychain: keychainService(epicenterRoot().id, located.name),
		};
	return [
		`${located.name}  ${located.declaration.description}`,
		`folder: ${located.folder}`,
		...(located.link ? [`link: ${located.link}`] : []),
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
