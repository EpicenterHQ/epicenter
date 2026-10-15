/**
 * What a notes folder needs before it is shown, done through the folder
 * itself: a directory for each declared table, and a `kv.json`.
 *
 * This runs after the desktop folder is granted, so the directory's lock is
 * already held and every change goes through the folder. It looks first and
 * changes only what is missing:
 *
 * - A table directory is made when the listing does not have it.
 * - `kv.json` is written only after a read confirmed it is not there, and
 *   only on the condition that it is still absent. A file that appeared in
 *   between stays as it is.
 *
 * No commit is requested here. Writing the default `kv.json` is a save like
 * any other, recorded in history only when the person saves a version; a
 * folder that already has its `kv.json` is opened without touching its
 * history.
 *
 * Anything else is a refusal: the folder is not set up, the caller shows why,
 * and nothing is tried again. That includes a write whose outcome is unknown.
 */
import type { NotesFolder } from './types.js';

/** The folder library's fixed settings file. */
const KV_PATH = 'kv.json';

function refused(error: { readonly message: string }): Error {
	return new Error(`The notes folder could not be set up: ${error.message}`);
}

export async function setUpFolder(
	files: Pick<NotesFolder['files'], 'list' | 'mkdir' | 'read' | 'create'>,
	/** The declared table names; each is a directory of the folder. */
	tables: readonly string[],
): Promise<void> {
	const { data: listing, error: listError } = await files.list();
	if (listError) throw refused(listError);
	for (const table of tables) {
		if (listing.directories.includes(table)) continue;
		const { error: mkdirError } = await files.mkdir(table);
		if (mkdirError) throw refused(mkdirError);
	}

	const { error: readError } = await files.read(KV_PATH);
	if (readError === null) return;
	// Only a confirmed absence is a missing file. Any other failure to read
	// might be a file that is there.
	if (readError.name !== 'NotFound') throw refused(readError);
	const { error: createError } = await files.create(KV_PATH, '{}\n');
	// Another writer created it first: theirs stands.
	if (createError && createError.name !== 'Exists') throw refused(createError);
}
