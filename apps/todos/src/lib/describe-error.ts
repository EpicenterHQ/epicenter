/**
 * What a person is told about a failure. The store returns typed errors and
 * never words them; components call this where they show one.
 */
import type { FileError, MoveError, TableError } from '@epicenter/folder';
import { basename } from '@epicenter/folder/file-browser';
import type { TodosError } from './todos.svelte.js';

/**
 * Library errors state failures precisely; these are the ones a person acts
 * on. A refusal changed nothing, a move that kept its source left both
 * files, and a lost reply leaves the outcome unknown.
 */
export function describeError(
	error: FileError | MoveError | TableError | TodosError,
): string {
	switch (error.name) {
		case 'NotStarted':
			return error.reason;
		case 'Exists':
			return `"${basename(error.path)}" already exists here.`;
		case 'Conflict':
			return error.actualSha256 === undefined
				? 'The file is no longer here, so nothing was changed.'
				: 'The file changed elsewhere, so nothing was changed. Its current version is shown.';
		case 'DirectoryNotEmpty':
			return 'The folder is not empty, so nothing was deleted.';
		case 'SourceNotRemoved':
			return `The file was copied to ${error.to}, but ${error.from} could not be removed, so the folder now has both. Delete whichever you do not want.`;
		case 'Unconfirmed':
			return `The change was sent, but nothing confirmed it, so it may or may not have happened. ${error.message}`;
		case 'InvalidValues':
			return error.issues.map((issue) => issue.message).join(' ');
		default:
			return error.message;
	}
}
