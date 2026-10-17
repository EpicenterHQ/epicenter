/**
 * What `<FolderApp>` shows when an app's folder does not open: one screen,
 * worded per refusal. Nothing else is opened in the folder's place.
 *
 * Plain module, so the wording is tested without mounting anything.
 */
import type { OpenFolderError } from '@epicenter/folder';

/** The refusal screen's text, and whether opening again could help. */
export type OpenRefusal = {
	readonly description: string;
	/** Whether to offer "Try again": the folder may open on a second attempt. */
	readonly retry: boolean;
};

/**
 * Word why the app titled `title` could not open its folder. A refusal that
 * names the folder already says enough (`DefinitionMismatch` names the app and the
 * folder and every missing table); one a person cannot act on from its
 * library message gets the sentence they need.
 */
export function describeOpenRefusal(
	error: OpenFolderError,
	title: string,
): OpenRefusal {
	switch (error.name) {
		case 'DefinitionMismatch':
			return {
				description: `${error.message} Open this folder with an app that reads it.`,
				retry: false,
			};
		case 'AppMismatch':
			return {
				// Neutral: an app with no installed build cannot be opened from
				// Epicenter, so this does not say where to open it.
				description: `This window was opened for ${error.windowApp === null ? 'no app' : `'${error.windowApp}'`}, so ${title} cannot open a folder in it.`,
				retry: false,
			};
		case 'InvalidDefinition':
			// A folder's own file that cannot be used can be repaired; the app's
			// own definition cannot be, by the person.
			return error.path === undefined
				? { description: error.message, retry: false }
				: {
						description: `${error.message} Fix or remove the folder's ${error.path}, then try again.`,
						retry: true,
					};
		case 'NoFileSystem':
			return {
				description: `This browser cannot keep ${title}'s files: ${error.missing} is not available here. Open ${title} in a current browser.`,
				retry: false,
			};
		case 'ShuttingDown':
			return { description: 'Epicenter is shutting down.', retry: false };
		case 'Missing':
		case 'Unavailable':
			return { description: error.message, retry: true };
		default:
			return { description: error.message, retry: false };
	}
}
