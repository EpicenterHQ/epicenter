/**
 * Vocab's folder: this browser's own storage, under one stable ID, with no
 * account and no sign-in. Reopening the page opens the same folder.
 *
 * It opens through the browser entry only. Vocab has no desktop build, so
 * there is no directory on disk: a page inside the desktop app is refused
 * here instead of being given browser storage.
 */
import { APPS } from '@epicenter/constants/apps';
import { openFolder } from '@epicenter/folder/browser';
import { type VocabFolder, vocabFolder } from './data.js';

/** The one folder Vocab opens. Its ID names the OPFS directory. */
export const VOCAB_FOLDER_ID = APPS.VOCAB.id;

/** Called from the mounted page; importing this module opens nothing. */
export async function openVocabFolder(): Promise<VocabFolder> {
	const { data: folder, error: openError } = await openFolder({
		app: VOCAB_FOLDER_ID,
		definition: vocabFolder,
		// History stays in this browser: a local author and no remote. Nothing
		// leaves this device until a remote is configured separately.
		browser: { author: { name: 'Vocab', email: 'vocab@localhost' } },
	});
	if (openError !== null)
		throw new Error(openError.message, { cause: openError });
	return folder;
}
