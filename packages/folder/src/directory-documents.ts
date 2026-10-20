/** Read saved Markdown for desktop SQL without opening or mutating a Folder. */
import { realpath, stat } from 'node:fs/promises';
import { Ok } from 'wellcrafted/result';
import { nodeDirectoryPrimitives } from './directory-node.js';
import { createDirectoryStorage } from './directory-store.js';
import { readDocuments } from './documents.js';
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
	return readDocuments({
		async list() {
			const result = await storage.list();
			return result.error === null
				? Ok(result.data.files.map(({ path }) => path))
				: ReadError.StorageFailed({ cause: result.error });
		},
		async read(path) {
			if (!readablePath(path)) return Ok(undefined);
			const result = await storage.read(path);
			if (
				result.error?.name === 'NotFound' ||
				result.error?.name === 'NotAFile'
			)
				return Ok(undefined);
			return result.error === null
				? Ok({ path, content: new Blob([new Uint8Array(result.data.bytes)]) })
				: ReadError.StorageFailed({ cause: result.error });
		},
	});
}
