/**
 * Where a data folder can never be: inside a `.git` or `.epicenter`
 * directory, which belong to Git and to Epicenter. A folder there would be
 * Git's state or another folder's unfinished writes, which that folder
 * recovers and removes. Any other directory may be a folder, `~/.notes`
 * among them.
 *
 * This is the folder core's rule (`admission::is_reserved_directory` and
 * `admission::resolved` in `tauri-plugin-epicenter-folder/core`), which the
 * Epicenter app asks before it sets a folder up and an app window asks
 * before it opens a root; `epicenter init` and `epicenter clone` ask it
 * here. `fixtures/reserved-directories.json` holds both to the same paths.
 */

import { realpath } from 'node:fs/promises';
import { STATE_DIRECTORY } from '@epicenter/folder/bun';

/** The directory names no folder is ever inside: Git's, and Epicenter's unfinished writes. */
export const RESERVED_DIRECTORIES = ['.git', STATE_DIRECTORY] as const;

/** `name` with its ASCII letters lowercased, as Rust's `eq_ignore_ascii_case` compares. */
const asciiLower = (name: string) =>
	name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/**
 * Whether some segment of `canonical`, a canonical path (`canonicalPath`),
 * is `.git` or `.epicenter`, in any ASCII case: a canonical path keeps a
 * name as it was made, and on a disk that ignores case Git and Epicenter
 * take a directory made as `.GIT` or `.Epicenter` for their own.
 */
export function isReservedDirectory(canonical: string): boolean {
	return canonical
		.split(/[\\/]/)
		.some((segment) =>
			RESERVED_DIRECTORIES.some((reserved) => asciiLower(segment) === reserved),
		);
}

/**
 * `path`, relative to `cwd` unless absolute, with each existing ancestor
 * resolved to its real path and the missing rest appended as written, `..`
 * dropping the segment before it once that is resolved: a link on the way is
 * followed, so it is no route around the rule.
 */
export async function canonicalPath(
	path: string,
	cwd = process.cwd(),
): Promise<string> {
	const absolute = path.startsWith('/') ? path : `${cwd}/${path}`;
	let result = '';
	for (const segment of absolute.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			result = result.slice(0, Math.max(0, result.lastIndexOf('/')));
			continue;
		}
		result = `${result}/${segment}`;
		try {
			result = await realpath(result);
		} catch {
			// Missing: kept as written, and so is everything under it.
		}
	}
	return result === '' ? '/' : result;
}
