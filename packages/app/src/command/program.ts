/**
 * What serve loads when it starts, once: the home's `epicenter.ts` and its
 * `AGENTS.md`. The whole program loads or none of it does: a module that
 * throws, or a `defineEpicenter` that refuses what it was given, leaves
 * serve with no apps and that one problem. To run changed code, restart
 * serve.
 */
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, tryAsync } from 'wellcrafted/result';
import { type App, isEpicenter } from '../epicenter.ts';

/** The home's program as serve answers from it. */
export type Program = {
	apps: Record<string, App>;
	/** Why `epicenter.ts` did not load; then there are no apps. */
	problem?: string;
	/** The home's `AGENTS.md`, sent to MCP clients at initialize. */
	instructions?: string;
};

/** Import `<folder>/epicenter.ts` and read `<folder>/AGENTS.md`. Never throws. */
export async function loadProgram(folder: string): Promise<Program> {
	const instructions = await readFile(join(folder, 'AGENTS.md'), 'utf8').catch(
		() => undefined,
	);
	// Paths inside the home read the same on every computer.
	const fromHome = (message: string) =>
		message.replaceAll(`${folder}${sep}`, '');
	const { data: module, error } = await tryAsync({
		try: (): Promise<{ default?: unknown }> =>
			import(pathToFileURL(join(folder, 'epicenter.ts')).href),
		catch: (cause) =>
			Err(`epicenter.ts did not load: ${fromHome(extractErrorMessage(cause))}`),
	});
	if (error !== null) return { apps: {}, problem: error, instructions };
	if (!isEpicenter(module.default))
		return {
			apps: {},
			problem:
				'epicenter.ts must default-export defineEpicenter({ apps }), and it exports something else',
			instructions,
		};
	return { apps: module.default.apps, instructions };
}
