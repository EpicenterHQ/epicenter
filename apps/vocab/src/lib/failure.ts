import type { ReadError, WriteError } from '@epicenter/folder/next';
import { extractErrorMessage } from 'wellcrafted/error';

/** What a learner is told about a save or read that failed. */
export function describeFailure(error: WriteError | ReadError): string {
	switch (error.name) {
		case 'StorageFailed':
			return `This browser's storage refused it: ${extractErrorMessage(error.cause)}.`;
		case 'Unparseable':
			return `Its file cannot be edited as a word: ${error.reason}.`;
		case 'NotText':
			return 'Its file is not text, so Vocab cannot change it.';
		case 'Closed':
			return 'The folder is closed.';
		case 'Exists':
			return 'A file already exists at this path.';
		case 'NothingToUpdate':
			return 'The file to update is missing.';
		case 'KeptChanging':
			return 'The file changed while Vocab tried to save it.';
		default:
			return error.message;
	}
}
