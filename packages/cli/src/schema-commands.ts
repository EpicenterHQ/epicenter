/** Explicit portable schema exchange; no app installation or opening publishes schemas. */
import { readFile } from 'node:fs/promises';
import {
	exportFolderSchemas,
	importFolderSchemas,
} from '@epicenter/folder/bun';
import { EXIT, fail, writeJson, writeOut } from './output.ts';

export async function exportSchemas(directory: string, json: boolean) {
	const result = await exportFolderSchemas(directory);
	if (result.error !== null) return fail(result.error.reason, json);
	writeJson(result.data);
	return EXIT.ok;
}

export async function importSchemas(
	directory: string,
	input: string,
	replace: boolean,
	json: boolean,
) {
	let source: string;
	try {
		const bytes =
			input === '-'
				? new Uint8Array(await Bun.stdin.arrayBuffer())
				: await readFile(input);
		source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	} catch (cause) {
		return fail(
			`Could not read schema source '${input}': ${cause instanceof Error ? cause.message : String(cause)}`,
			json,
		);
	}
	const result = await importFolderSchemas(directory, source, { replace });
	if (result.error !== null) return fail(result.error.reason, json);
	if (json) writeJson({ ...result.data, path: 'epicenter.json' });
	else
		writeOut(
			`${result.data.written ? 'updated' : 'unchanged'} epicenter.json tables`,
		);
	return EXIT.ok;
}
