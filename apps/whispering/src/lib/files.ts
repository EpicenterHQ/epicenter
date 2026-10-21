/** App-owned file messages, and reading a file's bytes. */
import type { FolderFiles, ReadError, SaveError } from '@epicenter/folder';
import { joinPath, pathProblem } from '@epicenter/folder/file-browser';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';

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
 * on. A save that failed changed nothing (ADR-0632).
 */
export function describeError(
	error:
		| SaveError
		| ReadError
		| { readonly name: string; readonly message: string },
): string {
	const known = error as SaveError | ReadError;
	switch (known.name) {
		case 'StorageFailed':
			return `The folder’s storage refused it, so nothing was changed: ${extractErrorMessage(known.cause)}`;
		case 'Unparseable':
			return `Its fields could not be changed, because its frontmatter does not read: ${known.reason}. Fix it in Source.`;
		case 'NotText':
			return 'It is not text, so it was not changed.';
		case 'Occupied':
			return `${known.existing} is a ${known.kind}, so nothing was saved at ${known.path}.`;
		case 'CaseTwin':
			return `${known.existing} differs only by case, so nothing was saved at ${known.path}.`;
		default:
			return error.message;
	}
}

/**
 * The folder's files as last listed: every file's path, and the directories
 * those paths pass through. A folder keeps files, so a directory with no file
 * in it is not listed.
 */
export type Listing = {
	readonly files: readonly string[];
	readonly paths: ReadonlySet<string>;
	/** Same-stem siblings, indexed once per listing rather than scanned per recording. */
	byStem: ReadonlyMap<string, readonly string[]>;
	readonly directories: readonly string[];
};

export function listingOf(files: readonly string[]): Listing {
	const directories = new Set<string>();
	const byStem = new Map<string, string[]>();
	for (const path of files) {
		const dot = path.lastIndexOf('.');
		if (dot > path.lastIndexOf('/') + 1) {
			const stem = path.slice(0, dot);
			const siblings = byStem.get(stem) ?? [];
			siblings.push(path);
			byStem.set(stem, siblings);
		}
		const parts = path.split('/');
		for (let end = 1; end < parts.length; end++)
			directories.add(parts.slice(0, end).join('/'));
	}
	return {
		files,
		paths: new Set(files),
		byStem,
		directories: [...directories].sort(),
	};
}

/** The file at `path` as bytes, or why it could not be read. */
export async function readBytes(
	folder: { readonly files: Pick<FolderFiles, 'read'> },
	path: string,
): Promise<Result<Uint8Array, string>> {
	const { data: file, error } = await folder.files.read(path);
	if (error !== null) return Err(error.message);
	if (file === undefined) return Err(`No file exists at '${path}'.`);
	return Ok(new Uint8Array(await file.content.arrayBuffer()));
}
