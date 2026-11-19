/**
 * What serve loads when it starts, once: the home's `epicenter.ts`. The
 * whole program loads or none of it does: a module that throws, or
 * anything serve refuses (`programOf`), leaves serve with no apps and
 * that one problem. To run changed code, restart serve.
 */
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TSchema } from 'typebox';
import { Compile, type Validator } from 'typebox/compile';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, tryAsync, trySync } from 'wellcrafted/result';
import type { Action } from '../action.ts';
import type { App, Epicenter } from '../epicenter.ts';
import { isPlainObject } from '../json.ts';
import { isName, NAME_RULE } from '../name.ts';

/** The home's program as serve answers from it. */
export type Program = {
	apps: Record<string, App>;
	/**
	 * Each action's input schema, compiled once when the program loaded.
	 * Every call runs this checker, so one that compiled cannot fail a call.
	 */
	inputChecks: ReadonlyMap<Action, Validator>;
	/** Why `epicenter.ts` did not load; then there are no apps. */
	problem?: string;
};

/** A program that did not load: no apps, and why. */
const refused = (problem: string): Program => ({
	apps: {},
	inputChecks: new Map(),
	problem,
});

/** Import `<folder>/epicenter.ts`. Never throws. */
export async function loadProgram(folder: string): Promise<Program> {
	// Paths inside the home read the same on every computer.
	const fromHome = (message: string) =>
		message.replaceAll(`${folder}${sep}`, '');
	const { data: module, error } = await tryAsync({
		try: (): Promise<{ default?: unknown }> =>
			import(pathToFileURL(join(folder, 'epicenter.ts')).href),
		catch: (cause) =>
			Err(`epicenter.ts did not load: ${fromHome(extractErrorMessage(cause))}`),
	});
	if (error !== null) return refused(error);
	return programOf(module.default);
}

/**
 * The program in what `epicenter.ts` default-exported, with each action's
 * input schema compiled, or what serve refuses in it, one sentence each: no
 * `apps` object, an app or action name that is not a name, an app that is
 * not `{ description, actions }`, an action that is not a function, or an
 * input schema TypeBox cannot compile, such as a raw `pattern` that is not
 * a regular expression. An MCP tool is `<app>_<action>`, so a name with
 * `_` would be read wrongly.
 */
export function programOf(exported: unknown): Program {
	const apps = isPlainObject(exported) ? exported.apps : undefined;
	if (!isPlainObject(apps))
		return refused(
			'epicenter.ts must default-export defineEpicenter({ apps })',
		);
	const problems: string[] = [];
	const inputChecks = new Map<Action, Validator>();
	for (const [name, app] of Object.entries(apps)) {
		if (!isName(name))
			problems.push(
				`The app name ${JSON.stringify(name)} must be ${NAME_RULE}`,
			);
		const actions = isPlainObject(app) ? app.actions : undefined;
		if (!isPlainObject(actions)) {
			problems.push(
				`apps.${name} must be what its app returns: { description, actions }`,
			);
			continue;
		}
		for (const [action, run] of Object.entries(actions)) {
			if (!isName(action))
				problems.push(
					`apps.${name} has the action ${JSON.stringify(action)}, which must be ${NAME_RULE}`,
				);
			const input: unknown =
				typeof run === 'function' ? (run as Partial<Action>).input : undefined;
			if (!isPlainObject(input)) {
				problems.push(`apps.${name}.${action} must be made with defineAction`);
				continue;
			}
			const { data: check, error } = trySync({
				try: () => Compile(input as TSchema),
				catch: (cause) => Err(extractErrorMessage(cause)),
			});
			if (error !== null)
				problems.push(
					`apps.${name}.${action} has an input schema that does not compile: ${error}`,
				);
			else inputChecks.set(run as Action, check);
		}
	}
	if (problems.length) return refused(problems.join('\n'));
	return { apps: (exported as Epicenter).apps, inputChecks };
}
