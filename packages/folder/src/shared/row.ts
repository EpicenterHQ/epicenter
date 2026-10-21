/** A table row adds its id and required frontmatter policy to Markdown values. */
import type { TSchema as Schema } from 'typebox';
import {
	changeMarkdown,
	readMarkdown,
	type MarkdownChange,
	type MarkdownValue,
} from './markdown-codec.js';

export type { Issue, MarkdownValue } from './markdown-codec.js';

export type Row<TSchema extends Schema = Schema> = MarkdownValue<TSchema> & {
	id: string;
};

export type RowChange = MarkdownChange;

export function readRow<const TSchema extends Schema>(
	id: string,
	content: string | Uint8Array,
	schema: TSchema,
): Row<TSchema> {
	return { id, ...readMarkdown(content, schema, 'required') };
}

export function rowChange(
	from: Pick<Row, 'text' | 'issues'> | null,
	change: RowChange,
) {
	return changeMarkdown(from, change, 'required');
}
