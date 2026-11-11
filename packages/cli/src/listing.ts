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
import type { appStatusOf, RepositoryStatus } from './snapshot.ts';

/** What Git says of the app's code and its data (ADR-0877); each absent when the app has no such repository. */
type Status = Awaited<ReturnType<typeof appStatusOf>> | undefined;

/** Whether a repository has nothing pending and a backup that has everything. */
const settled = (status: RepositoryStatus | undefined) =>
	!status || (status.pending === 0 && !status.unpushed && !status.backup);

/**
 * Git-derived status as `--json` gives it, for the code and the data:
 * pending paths, commits not backed up, a backup that is missing or has
 * never received the branch, and data written under code this code does not
 * have; absent when both are settled.
 */
function listingStatus(status: Status) {
	if (
		!status ||
		(settled(status.code) && settled(status.data) && !status.data?.otherCode)
	)
		return {};
	return { status };
}

/** One repository's history and backup status in a few words each, each starting with which repository. */
function repositoryMarks(which: 'code' | 'data', status?: RepositoryStatus) {
	if (!status) return [];
	return [
		...(status.pending
			? [
					`${which}: ${status.pending} ${status.pending === 1 ? 'change' : 'changes'} not yet in history`,
				]
			: []),
		...(status.unpushed
			? [
					`${which}: ${status.unpushed} ${status.unpushed === 1 ? 'snapshot' : 'snapshots'} not backed up`,
				]
			: []),
		...(status.backup === 'none' ? [`${which}: not backed up`] : []),
		...(status.backup === 'never' ? [`${which}: never backed up`] : []),
	];
}

/** An app's history and backup status, for its code and its data. */
function statusMarks(status: Status) {
	return [
		...repositoryMarks('code', status?.code),
		...repositoryMarks('data', status?.data),
		...(status?.data?.otherCode
			? [
					`data: written under code ${status.data.otherCode}, which this code's history does not have`,
				]
			: []),
	];
}

/** The step that settles an app's status, or nothing when it is settled. */
function syncStep(name: string, folder: string, status: Status) {
	const remotes = [
		...(status?.code?.backup === 'none' ? [folder] : []),
		...(status?.data?.backup === 'none' ? [`${folder}/data`] : []),
	];
	if (remotes.length)
		return `Run: ${remotes.map((at) => `git -C ${at} remote add origin <url>`).join(' and ')}, then epicenter sync ${name}`;
	if (!settled(status?.code) || !settled(status?.data))
		return `Run: epicenter sync ${name}`;
	if (status?.data?.otherCode) return `Run: epicenter history ${name}`;
	return undefined;
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
		...listingStatus(history),
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

/** Render discovery as one answer while keeping broken entries separate from runnable apps; an app with changes not yet in history is marked. */
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
	const lines = found.apps.map((located) => {
		const marks = statusMarks(histories.get(located.name));
		return `${located.name.padEnd(width)}  ${located.app.description}${located.link ? ` -> ${located.link}` : ''}${marks.length ? ` (${marks.join('; ')})` : ''}`;
	});
	if (!found.apps.length) lines.push('No apps yet. Run: epicenter new <name>');
	else lines.push('', 'Run: epicenter <app>');
	for (const app of found.apps) {
		const step = syncStep(app.name, app.folder, histories.get(app.name));
		if (step) lines.push(step);
	}
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

/** Render an app's actions, its folder, and what is not yet in its history or its backup. */
export function oneAppListing(
	located: Runnable,
	json: boolean,
	history: Status,
): unknown {
	if (json) return appListing(located, history);
	const step = syncStep(located.name, located.folder, history);
	return [
		`${located.name}  ${located.app.description}`,
		`folder: ${located.folder}`,
		...(located.link ? [`link: ${located.link}`] : []),
		...statusMarks(history),
		...(step ? [step] : []),
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
