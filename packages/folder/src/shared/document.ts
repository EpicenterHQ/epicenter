/**
 * One Markdown document at any path: missing frontmatter means empty fields,
 * malformed frontmatter stays visible with diagnostics, and a field edit may
 * introduce frontmatter. `documents.ts` reads a folder's documents through
 * these; the edit owner applies field edits to arbitrary files with them.
 */
import { type TSchema, Type } from 'typebox';
import { changeMarkdown, readMarkdown } from './markdown-codec.js';
import { type Row, type RowChange } from './row.js';

const anyFields = Type.Record(Type.String(), Type.Unknown());

export type Document = Row<typeof anyFields> & {
	readonly path: string;
	readonly directory: string;
	readonly stem: string;
};

/** Read one document without discarding its source when validation fails. */
export function readDocument(
	path: string,
	content: string | Uint8Array,
	schema: TSchema = anyFields,
): Document {
	const row = interpretedRow(path, content, schema);
	const slash = path.lastIndexOf('/');
	return {
		...row,
		path,
		directory: slash < 0 ? '' : path.slice(0, slash),
		stem: path.slice(slash + 1, -3),
	};
}

/** Add path identity around the same pure interpretation used by table rows. */
function interpretedRow(
	path: string,
	content: string | Uint8Array,
	schema: TSchema,
): Row<typeof anyFields> {
	// SAFETY: readMarkdown returns raw object fields on schema errors; anyFields accepts that shape.
	return { id: path, ...readMarkdown(content, schema) } as Row<
		typeof anyFields
	>;
}

/** A field edit may introduce frontmatter; a body edit alone need not. */
export function documentChange(
	from: Pick<Row, 'text' | 'issues'>,
	change: RowChange,
) {
	return changeMarkdown(from, change);
}
