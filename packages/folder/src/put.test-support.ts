/**
 * `put`: a test's way to make a file hold exact bytes, whatever is there.
 *
 * A test that seeds a file, or plays another writer, writes through the
 * folder's one write, which replaces whatever is at the path (ADR-0576).
 */
import type { Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import type { SaveError } from './shared/errors.js';
import type { FileContent } from './shared/merge.js';

export function put(
	folder: {
		write(
			path: string,
			to: FileContent | null,
		): Promise<Result<void, SaveError>>;
	},
	path: string,
	content: string | Uint8Array,
): Promise<Result<void, SaveError>> {
	return folder.write(path, content);
}

/**
 * Make `path` in raw storage hold `bytes`, or no file for `null`, whatever
 * is there: what another writer's change looks like to a folder.
 */
export async function overwrite(
	storage: Pick<FolderStorage, 'put'>,
	path: string,
	bytes: Uint8Array | string | null,
): Promise<void> {
	const content =
		typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
	const { error } = await storage.put(path, content, 'any');
	if (error !== null) throw new Error(error.message);
}
