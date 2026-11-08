/**
 * The home, app, and action views (ADR-0841). Human descriptions and JSON
 * listings come from the same actions and fields that commands and tools run,
 * so the person can see what is available and what needs fixing.
 */
import { type Action, isPositional } from '@epicenter/app';
import { type TSchemaOptions, Type } from 'typebox';
import type { Discovery, Located } from './home.ts';
import { fieldKind, flagOf, inputSchema, usageLine } from './input.ts';

/** Describe one action for JSON listings and action help from the same schemas MCP uses. */
export function actionListing(name: string, key: string, action: Action) {
	return {
		name: key,
		description: action.description,
		...(action.readOnly === true ? { readOnly: true } : {}),
		...(action.destructive === true ? { destructive: true } : {}),
		usage: usageLine(name, key, action),
		input: inputSchema(action),
	};
}

/** Describe a healthy app without exposing its executable module. */
export function appListing(located: Located) {
	if (!located.app) throw new Error(`${located.name} has no loaded app`);
	return {
		name: located.name,
		description: located.app.description,
		folder: located.folder,
		...(located.link ? { link: located.link } : {}),
		actions: Object.entries(located.app.actions).map(([key, action]) =>
			actionListing(located.name, key, action),
		),
	};
}

function actionLines(located: Located) {
	if (!located.app) throw new Error(`${located.name} has no loaded app`);
	return Object.entries(located.app.actions).flatMap(([key, action]) => [
		`  ${usageLine(located.name, key, action)}`,
		`    ${action.description}${action.readOnly ? ' (read-only)' : ''}${action.destructive ? ' (destructive)' : ''}`,
	]);
}

/** Render discovery as one answer while keeping broken entries separate from runnable apps. */
export function homeListing(found: Discovery, json: boolean): unknown {
	if (json)
		return {
			home: found.home,
			apps: found.apps.map(appListing),
			problems: found.problems.map(({ entry, folder, problems }) => ({
				entry,
				folder,
				problems,
			})),
			...(found.missing ? { missing: true } : {}),
		};
	if (found.missing)
		return `There is no Epicenter home at ${found.home}. Make one with: mkdir ${process.env.EPICENTER_HOME ? found.home : '~/Epicenter'}`;
	const lines = found.apps.flatMap((located) => {
		if (!located.app) throw new Error(`${located.name} has no loaded app`);
		return [
			`${located.name}  ${located.app.description}${located.link ? ` -> ${located.link}` : ''}`,
			...actionLines(located),
		];
	});
	if (!found.apps.length) lines.push('There are no apps yet.');
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

/** Render the app's disk and keychain locations beside its actions for inspection. */
export function oneAppListing(located: Located, json: boolean): unknown {
	if (!located.app) throw new Error(`${located.name} has no loaded app`);
	if (json)
		return {
			...appListing(located),
			cache: located.cacheDir,
			keychain: located.keychain,
		};
	return [
		located.name,
		located.app.description,
		`folder: ${located.folder}`,
		...(located.link ? [`link: ${located.link}`] : []),
		`cache: ${located.cacheDir}`,
		`keychain: ${located.keychain}`,
		...actionLines(located),
	].join('\n');
}

/** Explain each action field, including defaults and its positional spelling. */
export function actionHelp(name: string, key: string, action: Action): string {
	const required = new Set(Type.Object(action.input).required ?? []);
	return [
		usageLine(name, key, action),
		action.description,
		...Object.entries(action.input).map(([key, field]) => {
			const schema = field as TSchemaOptions;
			const status = Object.hasOwn(schema, 'default')
				? `default ${JSON.stringify(schema.default)}`
				: required.has(key)
					? 'required'
					: 'optional';
			return `  --${flagOf(key)}${isPositional(schema) ? ` (<${key}>)` : ''}: ${fieldKind(schema)}, ${status}${schema.description ? `, ${schema.description}` : ''}`;
		}),
	].join('\n');
}
