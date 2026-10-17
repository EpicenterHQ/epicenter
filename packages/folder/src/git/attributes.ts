/**
 * Whether a folder's or a tree's `.gitattributes` files name a Git filter.
 *
 * Epicenter writes and commits every file as the bytes it holds. Under a
 * filter such as `filter=lfs`, Git stores something else for those bytes (a
 * pointer), so another device's plain Git would not write back the same
 * file. Sync refuses such a tree, and a checkpoint such a folder (ADR-0592).
 *
 * This reads lines, not patterns: a line that assigns `filter`, set or with
 * a value, refuses even when its pattern selects no file, and a macro line
 * (`[attr]lfs filter=lfs`) refuses as its own line. Line-ending and encoding
 * attributes (`text`, `eol`, `crlf`, `working-tree-encoding`) and `ident`
 * pass: Epicenter applies none of them, so the bytes on disk are the bytes
 * committed.
 */

/** A line of an attribute file that assigns `filter`. */
export type FilterLine = {
	/** The attribute file's path in the folder or tree. */
	readonly path: string;
	/** The line's number, from 1. */
	readonly line: number;
	/** The line as written, without surrounding blanks. */
	readonly text: string;
};

/**
 * Whether a path names an attribute file. Any spelling counts, since a
 * case-insensitive disk opens `.GitAttributes` when Git asks for
 * `.gitattributes`.
 */
export const isAttributesPath = (path: string) =>
	path.slice(path.lastIndexOf('/') + 1).toLowerCase() === '.gitattributes';

/** A line's pattern: quoted, which may hold blanks, or up to the first blank. */
const PATTERN = /^(?:"(?:[^"\\]|\\.)*"|\S+)/;

/**
 * The first line, by path and then by line, that assigns `filter` in any of
 * `files`, which are attribute files by path. `undefined` when none does.
 */
export function declaredFilter(
	files: Iterable<readonly [string, Uint8Array]>,
): FilterLine | undefined {
	const decoder = new TextDecoder();
	const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	for (const [path, bytes] of sorted) {
		for (const [index, raw] of decoder.decode(bytes).split('\n').entries()) {
			const text = raw.trim();
			if (text === '' || text.startsWith('#')) continue;
			const assigns = text
				.replace(PATTERN, '')
				.split(/\s+/)
				.some((token) => token === 'filter' || token.startsWith('filter='));
			if (assigns) return { path, line: index + 1, text };
		}
	}
	return undefined;
}
