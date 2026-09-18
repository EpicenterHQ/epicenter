/**
 * Where a row's file lives, in both directions (ADR-0268, ADR-0271).
 *
 * One inverse pair, and the layout rule lives here rather than being spelled
 * twice at opposite ends of the package. The two directions used to be two
 * private functions with the same name in two files, which is how a layout
 * rule drifts: one of them gets a fix and the other does not.
 *
 * The address grammar is what makes this exact rather than approximate. A
 * table name is a bare identifier and a row id is path-safe with no leading
 * dot (`../definition/addresses.js`), so neither can hold a `/` or a `.`
 * that would make a path ambiguous, and nothing here escapes or unescapes
 * anything.
 */

/**
 * The extension every row file carries, whatever its table's node holds.
 *
 * **One extension for every table of every application, and it does not come
 * from the codec.** The platform owns the file and the table owns the mapping
 * (ADR-0296): a row file is a frontmatter block, a blank line, and text
 * beneath it, and `.md` is the name that format already has in every tool a
 * person or an agent reaches for. What a codec writes is a REGION inside that
 * file, and a region does not get to name the file: a conversation's node
 * encodes to a JSON array below a YAML fence, so `conversations/<id>.json`
 * would be a lie that breaks `jq` on the first byte.
 *
 * It also has to be knowable without a definition. The host sweeps every
 * row-shaped path a checkout did not name (`apps/epicenter/src/checkout.ts`)
 * and holds no definition and interprets no file, so `parseRowPath` cannot ask
 * a table what it writes. A fixed set of extensions the host would accept
 * instead buys a cosmetic `.txt` and costs a real hazard: a table whose
 * extension changed between releases leaves a stale sibling that reads as a
 * file nobody pulled, and a push would admit it as a second row.
 */
export const ROW_FILE_EXTENSION = '.md';

/** One row's file, relative to its store's folder. */
export function rowPath(table: string, rowId: string): string {
	return `${table}/${rowId}${ROW_FILE_EXTENSION}`;
}

/**
 * The row a path names, or `undefined` when the path is not a row file.
 *
 * `undefined` is a fact rather than a failure: a person's folder holds
 * `.DS_Store`, a `README.md` they wrote, and whatever else they put beside
 * their data, and none of that is a reason to refuse their data.
 */
export function parseRowPath(
	path: string,
): { table: string; rowId: string } | undefined {
	if (!path.endsWith(ROW_FILE_EXTENSION)) return undefined;
	const parts = path.slice(0, -ROW_FILE_EXTENSION.length).split('/');
	if (parts.length !== 2) return undefined;
	const [table, rowId] = parts;
	if (table === undefined || rowId === undefined) return undefined;
	if (table === '' || rowId === '') return undefined;
	return { table, rowId };
}
