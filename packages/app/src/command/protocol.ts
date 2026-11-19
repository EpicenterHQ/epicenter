/**
 * What the command and serve agree on over HTTP (ADR-0961): the header that
 * names an Epicenter, the refusal when a port answers for another one, the
 * MCP tool names, and the listing's types. Serve and the sender each import
 * this; neither imports the other, and nothing here loads an app.
 */
import { join } from 'node:path';
import type { ObjectSchema } from '../field.ts';
import { type Action, ActionError } from '../index.ts';
import { type EpicenterRoot, MARKER } from './root.ts';

/**
 * The header a request names its Epicenter in: the root's real path,
 * percent-encoded. The command sends it only to 127.0.0.1, so the path never
 * leaves this computer, and serve refuses a request whose root is not its
 * own with 409.
 */
export const ROOT_HEADER = 'x-epicenter-root';

/** This Epicenter as the header carries it: its root's real path, percent-encoded. */
export function rootHeaderValue({
	folder,
}: Pick<EpicenterRoot, 'folder'>): string {
	return encodeURIComponent(folder);
}

/**
 * The command's refusal when serve at `root`'s port answered 409: it serves
 * another Epicenter. It names the folder the command took for its
 * Epicenter and that folder's marker, since a stray `EPICENTER.md` below the
 * real one is the usual cause. Only this computer's terminal prints it.
 */
export function anotherEpicenter({ folder, port }: EpicenterRoot) {
	const marker = join(folder, MARKER);
	return ActionError.NotStarted({
		cause: 'unavailable',
		message: `The serve on port ${port} is another Epicenter's. This command took ${folder} for its Epicenter, from ${marker}: if that is not your Epicenter, remove that file; if it is, set a different \`port\` in it.`,
	});
}

/**
 * The MCP tool name of the action `action` in `app`: the two names joined by
 * `_`. Names have no underscores, so `fromToolName` reads it back.
 */
export const toolName = (app: string, action: string) => `${app}_${action}`;

/** The app and action a tool name names; an empty action for no such name. */
export function fromToolName(name: string) {
	const [app = '', action = '', ...more] = name.split('_');
	return { app, action: more.length ? '' : action };
}

/** A name that finds no app in the Epicenter: serve's answer, and the command's from the listing. */
export const unknownApp = (name: string) =>
	ActionError.NotStarted({
		cause: 'usage',
		message: `Unknown app "${name}"`,
		next: 'epicenter',
	});

/** An action `app` does not have, naming the actions it has: serve's answer, and the command's from the listing. */
export const noSuchAction = (app: string, action: string, actions: string[]) =>
	ActionError.NotStarted({
		cause: 'usage',
		message: `${app} has no action ${JSON.stringify(action)}; ${actions.length ? `its actions: ${actions.join(', ')}` : 'it has none'}`,
		next: `epicenter ${app}`,
	});

/** An app that does not load, refusing a call or a listing's view of it. */
export const appProblems = (name: string, problems: string[]) =>
	ActionError.NotStarted({
		cause: 'app-problems',
		message: `${name}: ${problems.join('; ')}`,
		app: name,
		problems,
	});

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

/** An app as the listing carries it: its description, each data key's path and fields as JSON Schema, and its actions as tools. */
export type AppListing = {
	name: string;
	description: string;
	data?: Record<
		string,
		{ path: string; description: string; fields: ObjectSchema }
	>;
	actions: ActionTool[];
};

/** An entry in `apps/` with problems: one that did not load, or a `local/` that could reach Git. */
export type AppProblems = { entry: string; problems: string[] };

/** A routine as the listing shows it: its schedule, next occurrence, and the action it runs with its input, or why its file is refused. */
export type RoutineRow =
	| {
			name: string;
			cron: string;
			next: string | undefined;
			app: string;
			action: string;
			input: Record<string, unknown>;
	  }
	| { name: string; problem: string };

/** Everything serve offers, as `GET /actions/` answers it. */
export type Listing = {
	/** The version of `@epicenter/app` serve runs. */
	version: string;
	apps: AppListing[];
	problems: AppProblems[];
	routines: RoutineRow[];
};
