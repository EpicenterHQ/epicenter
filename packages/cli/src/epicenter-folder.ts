/**
 * Epicenter's own folder, `so.epicenter` (ADR-0539): the AI connections every
 * app may use, as rows a person or an agent can read, edit, and version.
 *
 * Each AI connection is a row, `connections/<id>.md`, holding its kind,
 * title, and model (ADR-0557). Its endpoint and key are never in the folder:
 * they are in this computer's keychain under the same id. The table is
 * `@epicenter/ai`'s, so an installed app opens it through the same lens.
 *
 * Epicenter creates this folder, so it owns the schema. An installed app
 * opens it through a lens the published declaration must contain (ADR-0538),
 * and a handle publishes its declaration only before its first write
 * (ADR-0508). So the desktop app runs `epicenter declare-epicenter-folder`
 * at every launch (`spawn_epicenter_folder_declaration` in
 * `apps/epicenter/src-tauri/src/cli.rs`), and opens no installed app before
 * it has finished, whichever window opened first.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { connectionsTable } from '@epicenter/ai/connection-table';
import { defineFolder, type Folder } from '@epicenter/folder';
import { resolveAppPaths } from './app-paths.ts';
import { EXIT, fail, writeJson, writeOut } from './output.ts';

/** The folder's id, its directory's name under the Epicenter folder root. */
export const EPICENTER_FOLDER_ID = 'so.epicenter';

export const epicenterDefinition = defineFolder({
	title: 'Epicenter',
	kv: {},
	tables: {
		/** One row per AI connection, at `connections/<id>.md`. */
		connections: connectionsTable,
	},
});

/**
 * Make the handle's first write, which publishes its declaration first: the
 * `connections` table's directory, the table apps read through a lens. A
 * directory already there is left as it is, and so is an `epicenter.json`
 * that already holds the declaration's bytes.
 */
export async function declare(
	folder: Folder<typeof epicenterDefinition>,
): Promise<string | undefined> {
	const { error } = await folder.files.mkdir('connections');
	return error?.message;
}

/**
 * `epicenter declare-epicenter-folder`: publish `epicenterDefinition` to
 * `<folder dir>/so.epicenter/epicenter.json`, making the folder if it is
 * missing. Exits 0, or 2 with the problem.
 */
export async function declareEpicenterFolder(
	json: boolean,
	paths = resolveAppPaths(),
): Promise<number> {
	const root = join(dirname(paths.appsDir), EPICENTER_FOLDER_ID);
	await mkdir(root, { recursive: true });
	const { openFolder } = await import('@epicenter/folder/bun');
	const { data: folder, error } = await openFolder({
		root,
		definition: epicenterDefinition,
		git: { author: { name: 'Epicenter', email: 'epicenter@localhost' } },
	});
	if (error !== null) return fail(error.message, json);
	let problem: string | undefined;
	try {
		problem = await declare(folder);
	} finally {
		await folder.close();
	}
	if (problem !== undefined) return fail(problem, json);
	if (json) writeJson({ declared: root });
	else writeOut(`${root}/epicenter.json declares Epicenter's folder.`);
	return EXIT.ok;
}
