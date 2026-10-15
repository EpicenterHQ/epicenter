/**
 * `put`: a test's way to make a file hold exact bytes, whatever is there.
 *
 * No folder verb writes without naming what it replaces (ADR-0551). A test
 * that seeds a file, or plays another writer, reads it and saves over that
 * read without merging, or creates it when it is missing.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { CapturedFile } from './capture.js';
import type { FileSaveError } from './errors.js';
import type { FolderFiles } from './files.js';

export async function put(
	files: Pick<FolderFiles, 'read' | 'create' | 'save'>,
	path: string,
	content: string | Uint8Array,
): Promise<Result<CapturedFile, FileSaveError>> {
	const { data: current, error: readError } = await files.read(path);
	if (readError !== null) {
		if (readError.name !== 'NotFound') return Err(readError);
		return files.create(path, content);
	}
	const { data: saved, error } = await files.save(current, content, {
		merge: false,
	});
	return error === null ? Ok(saved.stored) : Err(error);
}
