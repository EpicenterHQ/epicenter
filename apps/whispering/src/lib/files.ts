/** App-owned file messages. */
import {
	type FileError,
	pathProblem,
	type RowWriteError,
} from '@epicenter/folder';
import { joinPath } from '@epicenter/folder/file-browser';

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
 * on. A refusal changed nothing, and a lost reply leaves the outcome unknown.
 */
export function describeError(
	error:
		| FileError
		| RowWriteError
		| { readonly name: string; readonly message: string },
): string {
	const known = error as FileError | RowWriteError;
	switch (known.name) {
		case 'DirectoryNotEmpty':
			return 'The folder is not empty, so nothing was deleted.';
		case 'Unconfirmed':
			return `The change was sent, but nothing confirmed it, so it may or may not have happened. ${known.message}`;
		case 'Io': {
			// A row write reports a lost reply as `Io` with the storage failure as its cause.
			const cause = known.cause as FileError | undefined;
			return cause?.name === 'Unconfirmed'
				? describeError(cause)
				: known.message;
		}
		case 'InvalidValues':
			return known.issues.map((issue) => issue.message).join(' ');
		case 'Occupied':
			return 'Another file already has this name, so nothing was changed.';
		default:
			return known.message;
	}
}
