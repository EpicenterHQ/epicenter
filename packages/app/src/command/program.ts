/**
 * What serve loads when it starts, once: the home's `epicenter.ts`. The
 * whole program loads or none of it does: a module that throws, or a
 * name serve refuses (`programProblems`), leaves serve with no
 * apps and that one problem. To run changed code, restart serve.
 */
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, tryAsync } from 'wellcrafted/result';
import { type App, type Epicenter, programProblems } from '../epicenter.ts';

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
