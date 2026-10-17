/**
 * What a notes folder needs before it is shown, done through the folder
 * itself: a directory for each declared table.
 *
 * This runs after the desktop folder is granted, so the directory's lock is
 * already held and every change goes through the folder. It looks first and
 * makes only the table directories the listing does not have, so a folder
 * that has them all is opened without a write. Any other file is
 * ordinary and left as it is.
 *
 * No commit is requested here. The declaration the first directory publishes
 * is recorded in history only when the person saves a version.
 *
 * Anything else is a refusal: the folder is not set up, the caller shows why,
 * and nothing is tried again.
 */
import type { NotesFolder } from './types.js';

function refused(error: { readonly message: string }): Error {
	return new Error(`The notes folder could not be set up: ${error.message}`);
}

export async function setUpFolder(
	files: Pick<NotesFolder['files'], 'list' | 'mkdir'>,
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
}
