/**
 * What serve loads when it starts, once: the home's `epicenter.ts`. The
 * whole program loads or none of it does: a module that throws, or
 * anything serve refuses (`programProblems`), leaves serve with no apps and
 * that one problem. To run changed code, restart serve.
 */
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, tryAsync, trySync } from 'wellcrafted/result';
import type { Action } from '../action.ts';
import type { App, Epicenter } from '../epicenter.ts';
import { isPlainObject } from '../json.ts';
import { isName, NAME_RULE } from '../name.ts';

/** The home's program as serve answers from it. */
export type Program = {
	apps: Record<string, App>;
	/** Why `epicenter.ts` did not load; then there are no apps. */
	problem?: string;
};

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
	if (error !== null) return { apps: {}, problem: error };
	const problems = programProblems(module.default);
	if (problems.length) return { apps: {}, problem: problems.join('\n') };
	return { apps: (module.default as Epicenter).apps };
}

/**
 * What serve refuses in what `epicenter.ts` default-exported, one sentence
 * each: no `apps` object, an app or action name that is not a name, an app
 * that is not `{ description, actions }`, an action that is not a function,
 * or an input schema TypeBox cannot compile, such as a raw `pattern` that is
 * not a regular expression. An MCP tool is `<app>_<action>`, so a name with
 * `_` would be read wrongly. Code changes only when serve restarts, so a
 * schema checked here cannot fail a call later.
 */
export function programProblems(program: unknown): string[] {
	const apps = isPlainObject(program) ? program.apps : undefined;
	if (!isPlainObject(apps))
		return ['epicenter.ts must default-export defineEpicenter({ apps })'];
	const problems: string[] = [];
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
			const { error } = trySync({
				try: () => Compile(input as TSchema),
				catch: (cause) => Err(extractErrorMessage(cause)),
			});
			if (error !== null)
				problems.push(
					`apps.${name}.${action} has an input schema that does not compile: ${error}`,
				);
		}
	}
	return problems;
}
