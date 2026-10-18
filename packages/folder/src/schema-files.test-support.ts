/**
 * A folder's tables as hand-written schema files, for tests: a `{ tables }`
 * map split into each table's `<table>/.epicenter.json`, written to and read
 * back from a directory, so a test can show the files are left byte for
 * byte.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { schemaPath } from './paths.js';

/**
 * Each table of `tables` as its schema file's text, by path: one line of
 * JSON, as a person might write it, not as a publication formats it.
 */
export function tableFiles(
	tables: Readonly<Record<string, object>>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(tables).map(([name, schema]) => [
			schemaPath(name),
			JSON.stringify(schema),
		]),
	);
}

/** Write `files`, each by its path under `root`. */
export async function writeFiles(
	root: string,
	files: Readonly<Record<string, string>>,
): Promise<void> {
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), text);
	}
}

/** Every top-level directory's `.epicenter.json` under `root`, by path. */
export async function readTables(
	root: string,
): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const path = schemaPath(entry.name);
		const text = await readFile(join(root, path), 'utf8').catch(
			() => undefined,
		);
		if (text !== undefined) files[path] = text;
	}
	return files;
}
