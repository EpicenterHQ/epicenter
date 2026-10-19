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
 * Word why the app titled `title` could not open its folder.
 */
export function describeOpenRefusal(
	error: OpenFolderError,
	title: string,
): OpenRefusal {
	switch (error.name) {
		case 'LegacyDataPresent':
			return {
				description: `Earlier folder files are still stored in this browser (${error.folders.join(', ')}). ${title} cannot read them yet, so it stopped before showing an empty workspace.`,
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
