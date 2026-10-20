/** Native declaration operations do not open a Folder or sweep its scratch files. */
import { Err } from 'wellcrafted/result';
import { importTables, parseTableSchemas } from '../declaration-write.js';
import { DEFINITION_PATH } from '../paths.js';
import { localRoot } from './directory.js';
import { nativeStorage } from './storage.js';

/** Export this folder's declared tables, without executing application code. */
export async function exportFolderSchemas(directory: string) {
	const root = await localRoot(directory);
	if (root.error !== null) return Err({ reason: String(root.error.cause) });
	const source = await nativeStorage(root.data).read(DEFINITION_PATH);
	if (source.error !== null) return Err({ reason: source.error.message });
	try {
		return parseTableSchemas(
			new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
				source.data.bytes,
			),
		);
	} catch {
		return Err({ reason: `${DEFINITION_PATH} is not UTF-8 text` });
	}
}

/** Explicit schema import into the existing folder under its shared save lock. */
export async function importFolderSchemas(
	directory: string,
	source: string,
	options: { replace?: boolean } = {},
) {
	const root = await localRoot(directory);
	if (root.error !== null) return Err({ reason: String(root.error.cause) });
	return importTables(nativeStorage(root.data), source, options);
}
