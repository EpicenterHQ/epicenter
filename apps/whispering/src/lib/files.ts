/** App-owned file messages. */
import {
	type FileError,
	type MoveError,
	pathProblem,
	type TableError,
} from '@epicenter/folder';
import { basename, joinPath } from '@epicenter/folder/file-browser';

export function nameProblem(
	directory: string,
	name: string,
): string | undefined {
	if (name === '') return 'Enter a name.';
	if (name.includes('/')) return 'A name cannot contain "/".';
	const problem = pathProblem(joinPath(directory, name));
	return problem === undefined
		? undefined
		: `This name is not usable: ${problem}.`;
}

/**
 * Library errors state failures precisely; these are the ones a person acts
 * on. A refusal changed nothing, a move that kept its source left both
 * files, and a lost reply leaves the outcome unknown.
 */
export function describeError(
	error:
		| FileError
		| MoveError
		| TableError
		| { readonly name: string; readonly message: string },
): string {
	const known = error as FileError | MoveError | TableError;
	switch (known.name) {
		case 'Exists':
			return `"${basename(known.path)}" already exists here.`;
		case 'Conflict':
			return known.actualSha256 === undefined
				? 'The file is no longer here, so nothing was changed.'
				: 'The file changed elsewhere, so nothing was changed. Check it and try again.';
		case 'DirectoryNotEmpty':
			return 'The folder is not empty, so nothing was deleted.';
		case 'SourceNotRemoved':
			return `"${basename(known.to)}" was written, but "${basename(known.from)}" could not be removed, so both are in the folder now.`;
		case 'Unconfirmed':
			return `The change was sent, but nothing confirmed it, so it may or may not have happened. ${known.message}`;
		case 'InvalidValues':
			return known.issues.map((issue) => issue.message).join(' ');
		default:
			return known.message;
	}
}
