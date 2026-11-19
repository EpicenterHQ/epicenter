/**
 * What serve loads when it starts, once: the home's `epicenter.ts` and its
 * `AGENTS.md`. The whole program loads or none of it does: a module that
 * throws, or a `defineEpicenter` that refuses what it was given, leaves
 * serve answering that one problem with no apps. To run changed code,
 * restart serve.
 */
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractErrorMessage } from 'wellcrafted/error';
import { type Epicenter, isEpicenter } from '../epicenter.ts';

/** The home's program, or why it did not load, and its agent guidance. */
export type Loaded = (
	| { epicenter: Epicenter; problem?: undefined }
	| { epicenter?: undefined; problem: string }
) & {
	/** The home's `AGENTS.md`, sent to MCP clients at initialize. */
	instructions: string | undefined;
};

/** Import `<folder>/epicenter.ts` and read `<folder>/AGENTS.md`. Never throws. */
export async function loadHome(folder: string): Promise<Loaded> {
	const instructions = await readFile(join(folder, 'AGENTS.md'), 'utf8').catch(
		() => undefined,
	);
	const file = join(folder, 'epicenter.ts');
	// Paths inside the home read the same on every computer.
	const fromHome = (message: string) =>
		message.replaceAll(`${folder}${sep}`, '');
	let module: { default?: unknown };
	try {
		module = await import(pathToFileURL(file).href);
	} catch (cause) {
		return {
			problem: `epicenter.ts did not load: ${fromHome(extractErrorMessage(cause))}`,
			instructions,
		};
	}
	if (!isEpicenter(module.default))
		return {
			problem:
				'epicenter.ts must default-export defineEpicenter({ apps }), and it exports something else',
			instructions,
		};
	return { epicenter: module.default, instructions };
}
