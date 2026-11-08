/**
 * The home, app, and action views (ADR-0841, ADR-0857). `--json` prints the
 * merged declaration with each action as the MCP tool `serve` offers, so a
 * listing and `tools/list` agree; the human views come from the same actions.
 */
import { type Action, ANNOTATION_DEFAULTS } from '@epicenter/app';
import { type TSchemaOptions, Type } from 'typebox';
import type { Discovery, Located } from './home.ts';
import { fieldKind, flagOf, jsonSchema, usageLine } from './input.ts';

/** An action as an MCP tool definition: its name, input schema, and all four hints, explicit. */
export function actionTool(app: string, key: string, action: Action) {
	return {
		name: `${app}_${key.replaceAll(' ', '_')}`,
		description: action.description,
		inputSchema: jsonSchema(action.input),
		annotations: { ...ANNOTATION_DEFAULTS, ...action.annotations },
	};
}

function loaded(located: Located) {
	if (!located.app) throw new Error(`${located.name} has no loaded app`);
	return located.app;
}

/** The app as `--json` prints it: its declaration, its code's collections as JSON Schema, and its actions as tools. */
export function appListing(located: Located) {
	const app = loaded(located);
	const { declaration } = app;
	return {
		name: located.name,
		description: declaration.description,
		folder: located.folder,
		...(located.link ? { link: located.link } : {}),
		collections: {
			...declaration.collections,
			...Object.fromEntries(
				Object.entries(app.collections).map(([key, { path, fields }]) => [
					key,
					{ path, fields: jsonSchema(fields) },
				]),
			),
		},
		actions: Object.entries(app.actions).map(([key, action]) =>
			actionTool(located.name, key, action),
		),
	};
}

function hints(action: Action) {
	const { readOnlyHint, destructiveHint } = {
		...ANNOTATION_DEFAULTS,
		...action.annotations,
	};
	if (readOnlyHint) return ' (read-only)';
	return destructiveHint ? '' : ' (not destructive)';
}

function actionLines(located: Located) {
	return Object.entries(loaded(located).actions).flatMap(([key, action]) => [
		`  ${usageLine(located.name, key, action)}`,
		`    ${action.description}${hints(action)}`,
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
		return `There is no Epicenter home at ${found.home}. Make one with: mkdir ${found.home}`;
	const lines = found.apps.flatMap((located) => [
		`${located.name}  ${loaded(located).declaration.description}${located.link ? ` -> ${located.link}` : ''}`,
		...actionLines(located),
	]);
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
	if (json)
		return {
			...appListing(located),
			cache: located.cacheDir,
			keychain: located.keychain,
		};
	return [
		located.name,
		loaded(located).declaration.description,
		`folder: ${located.folder}`,
		...(located.link ? [`link: ${located.link}`] : []),
		`cache: ${located.cacheDir}`,
		`keychain: ${located.keychain}`,
		...actionLines(located),
	].join('\n');
}

/** Explain each action field, including defaults and its positional spelling. */
export function actionHelp(name: string, key: string, action: Action): string {
	const positional = new Set<string>(action.positional ?? []);
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
			return `  --${flagOf(key)}${positional.has(key) ? ` (<${key}>)` : ''}: ${fieldKind(schema)}, ${status}${schema.description ? `, ${schema.description}` : ''}`;
		}),
	].join('\n');
}
