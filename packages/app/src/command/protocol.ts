/**
 * What the command and serve agree on over HTTP: the header that names a
 * home, the MCP tool names, and the listing. Serve and the command each
 * import this; neither imports the other, and nothing here loads app code.
 */
import type { ObjectSchema } from '../field.ts';

/**
 * The header a request from the command names its home in: the home's real
 * path, percent-encoded. The command sends it only to 127.0.0.1, so the path
 * never leaves this computer, and serve refuses a request for another home
 * with 409, so a command in a second home on the same port reaches nothing.
 */
export const HOME_HEADER = 'x-epicenter-home';

/** A home as the header carries it. */
export const homeHeaderValue = (folder: string) => encodeURIComponent(folder);

/**
 * The MCP tool name of `action` in `app`: the two names joined by `_`. A
 * name has no underscore, so `fromToolName` reads it back.
 */
export const toolName = (app: string, action: string) => `${app}_${action}`;

/** The app and action a tool name names; an empty action for no such name. */
export function fromToolName(name: string) {
	const [app = '', action = '', ...more] = name.split('_');
	return { app, action: more.length ? '' : action };
}

/** An action as the listing shows it. */
export type ActionListing = {
	name: string;
	description: string;
	input: ObjectSchema;
};

/** An app as the listing shows it. */
export type AppListing = {
	name: string;
	description: string;
	actions: ActionListing[];
};

/** Everything serve offers, as `GET /actions/` answers it. */
export type Listing = {
	/** The version of `@epicenter/app` serve runs. */
	version: string;
	apps: AppListing[];
	/** Why `epicenter.ts` did not load, when it did not; then there are no apps. */
	problem?: string;
};
