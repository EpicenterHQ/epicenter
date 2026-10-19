/**
 * `put`: a test's way to make a file hold exact bytes, whatever is there.
 *
 * A test that seeds a file, or plays another writer, writes through the
 * folder's one write from the bytes it just read, or from no file
 * (ADR-0576). With no change in between, the write leaves exactly `content`.
 */
import { Err, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import type { FileError } from './errors.js';
import type { SaveError } from './shared/errors.js';
import type { FileContent } from './shared/merge.js';

export async function put(
	folder: {
		readonly files: Pick<FolderStorage, 'read'>;
		write(
			path: string,
			from: FileContent | null,
			to: FileContent | null,
		): Promise<Result<void, SaveError>>;
	},
	path: string,
	content: string | Uint8Array,
): Promise<Result<void, SaveError | FileError>> {
	const { data: current, error } = await folder.files.read(path);
	if (error !== null && error.name !== 'NotFound') return Err(error);
	return folder.write(path, current?.bytes ?? null, content);
}

/**
 * Make `path` in raw storage hold `bytes`, or no file for `null`, whatever
 * is there: what another writer's change looks like to a folder.
 */
export async function overwrite(
	storage: Pick<FolderStorage, 'read' | 'put'>,
	path: string,
	bytes: Uint8Array | string | null,
): Promise<void> {
	const read = await storage.read(path);
	if (read.error !== null && read.error.name !== 'NotFound')
		throw new Error(read.error.message);
	const content =
		typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
	const { data, error } = await storage.put(
		path,
		content,
		read.error === null ? read.data.sha256 : null,
	);
	if (error !== null) throw new Error(error.message);
	if (data !== 'landed')
		throw new Error(`${path} changed while it was overwritten`);
}
