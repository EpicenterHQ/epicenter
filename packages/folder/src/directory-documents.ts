/** Read saved Markdown for desktop SQL without opening or mutating a Folder. */
import { realpath, stat } from 'node:fs/promises';
import { Ok } from 'wellcrafted/result';
import { nodeDirectoryPrimitives } from './directory-node.js';
import { createDirectoryStorage } from './directory-store.js';
import { documentsOf, type SavedFile } from './documents.js';
import { scratchDirectory } from './native/directory.js';
import { readablePath } from './paths.js';
import { ReadError } from './shared/errors.js';

export async function readDirectoryDocuments(directory: string) {
	const root = await realpath(directory);
	if (!(await stat(root)).isDirectory())
		throw new Error(`${directory} is not a directory`);
	const storage = createDirectoryStorage({
		root,
		primitives: nodeDirectoryPrimitives,
		scratch: scratchDirectory(root),
	});
	const listed = await storage.list();
	if (listed.error !== null)
		return ReadError.StorageFailed({ cause: listed.error });
	const files: SavedFile[] = [];
	for (const path of new Set([
		'epicenter.json',
		...listed.data.map(({ path }) => path),
	])) {
		if (!readablePath(path)) continue;
		if (path !== 'epicenter.json' && !path.endsWith('.md')) continue;
		const result = await storage.read(path);
		if (result.error?.name === 'NotFound') continue;
		if (result.error !== null) {
			files.push({
				path,
				data: undefined,
				readError: { message: result.error.message },
			});
			continue;
		}
		const bytes = new Uint8Array(result.data.bytes);
		let data: string | Uint8Array = bytes;
		try {
			data = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
				bytes,
			);
		} catch {
			// Preserve non-text bytes so the shared reader can classify them.
		}
		files.push({ path, data, readError: null });
	}
	return Ok(documentsOf(files));
}
