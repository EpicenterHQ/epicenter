/**
 * One Markdown document at any path: missing frontmatter means empty fields,
 * malformed frontmatter stays visible with diagnostics, and a field edit may
 * introduce frontmatter. `documents.ts` reads a folder's documents through
 * these; the edit owner applies field edits to arbitrary files with them.
 */
import { type TSchema, Type } from 'typebox';
import { frameRowText } from './content/markdown.js';
import { carryRead } from './observation.js';
import { type Row, type RowChange, readRow, rowChange } from './row.js';

const anyFields = Type.Record(Type.String(), Type.Unknown());
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type Document = Omit<Row, 'fields'> & {
	readonly fields: Record<string, unknown>;
	readonly path: string;
	readonly directory: string;
	readonly stem: string;
	readonly content: Uint8Array;
};

/** Read one document without discarding its source when validation fails. */
export function readDocument(
	path: string,
	content: Uint8Array,
	schema: TSchema = anyFields,
): Document {
	let row = interpretedRow(path, content, schema);
	try {
		const text = decoder.decode(content);
		if (
			!text.includes('\0') &&
			text.isWellFormed() &&
			frameRowText(text).kind === 'missing'
		) {
			row = {
				...interpretedRow(path, `---\n---\n${text}`, schema),
				text,
				body: text,
			};
		}
	} catch {
		// readRow already reports the exact decoding failure.
	}
	const slash = path.lastIndexOf('/');
	const copy = new Uint8Array(content);
	// The copy is the same read's content.
	carryRead(content, copy);
	return {
		...row,
		fields: row.fields as Record<string, unknown>,
		path,
		directory: slash < 0 ? '' : path.slice(0, slash),
		stem: path.slice(slash + 1, -3),
		content: copy,
	};
}

/** Validator failures remain a document issue beside repairable source. */
function interpretedRow(
	path: string,
	content: string | Uint8Array,
	schema: TSchema,
): Row {
	try {
		return readRow(path, content, schema);
	} catch (cause) {
		const raw = readRow(path, content, anyFields);
		return {
			...raw,
			issues: [
				...(raw.issues ?? []),
				{
					kind: 'schema',
					path: [],
					message: `Schema validation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				},
			],
		};
	}
}

/** A field edit may introduce frontmatter; a body edit alone need not. */
export function documentChange(
	from: Pick<Row, 'text' | 'issues'>,
	change: RowChange,
) {
	if (frameRowText(from.text).kind !== 'missing')
		return rowChange(from, change);
	if (change.fields === undefined) return rowChange(from, change);
	const bom = from.text.startsWith('﻿') ? '﻿' : '';
	const newline =
		from.text.includes('\r\n') &&
		!from.text.replaceAll('\r\n', '').includes('\n')
			? '\r\n'
			: '\n';
	return rowChange(
		{
			...from,
			text: `${bom}---${newline}---${newline}${from.text.slice(bom.length)}`,
		},
		change,
	);
}
