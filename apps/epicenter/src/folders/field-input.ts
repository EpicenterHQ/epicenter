/**
 * How the Folders window edits one declared field: which editor its schema
 * gets (`fieldEditorOf`), and how an editor's text becomes the value saved.
 *
 * The editor follows the field's `x-field` hint where the schema has that
 * widget's shape, and is the JSON editor otherwise. Text editors cover every
 * kind but boolean, select, and multiSelect, which save values directly.
 * Dates are `YYYY-MM-DD`; instants and datetimes are edited as their ISO
 * text, since a `datetime-local` input would drop seconds and the offset.
 * The schema decides validity when the row is saved, so a value the editor
 * passes may still be refused there.
 */

import {
	type FieldEditor,
	fieldEditorOf,
	isOptional,
} from '@epicenter/definition';
import type { PreparedFolderTable } from '@epicenter/folder';

/** One declared field as a grid column. */
export type FieldColumn = {
	readonly name: string;
	readonly editor: FieldEditor;
	/** Whether a row may leave the field out, so clearing it removes it. */
	readonly optional: boolean;
};

/** The table's declared fields, in declared order. */
export function columnsOf(table: PreparedFolderTable): FieldColumn[] {
	return Object.entries(table.fields).map(([name, schema]) => ({
		name,
		editor: fieldEditorOf(schema),
		optional: isOptional(schema),
	}));
}

/** The editor kinds that edit through one line of text. */
export type TextKind = Exclude<
	FieldEditor['kind'],
	'boolean' | 'select' | 'multiSelect'
>;

/** What committing an editor's text does to the field. */
export type TextCommit =
	| { readonly kind: 'set'; readonly value: unknown }
	/** Leave the field out of the row; only for an optional field. */
	| { readonly kind: 'remove' }
	/** Nothing to save: the text has no value of this kind and the field is required. */
	| { readonly kind: 'unchanged' }
	| { readonly kind: 'invalid'; readonly message: string };

/** The text an editor starts from for a stored value, `undefined` for none. */
export function textOf(kind: TextKind, value: unknown): string {
	if (value === undefined) return '';
	switch (kind) {
		case 'json':
			return JSON.stringify(value, null, 2);
		case 'tags':
			return Array.isArray(value) ? value.map(String).join(', ') : '';
		default:
			return typeof value === 'string' ? value : JSON.stringify(value);
	}
}

/** The value an editor's committed text saves. */
export function commitText(column: FieldColumn, text: string): TextCommit {
	const kind = column.editor.kind as TextKind;
	const trimmed = text.trim();
	if (trimmed === '') {
		if (column.optional) return { kind: 'remove' };
		// An empty string is a value of a text field; other kinds have none.
		return kind === 'string' || kind === 'reference' || kind === 'url'
			? { kind: 'set', value: '' }
			: { kind: 'unchanged' };
	}
	switch (kind) {
		case 'number':
		case 'integer': {
			const number = Number(trimmed);
			if (!Number.isFinite(number))
				return { kind: 'invalid', message: 'Enter a number.' };
			if (kind === 'integer' && !Number.isInteger(number))
				return { kind: 'invalid', message: 'Enter a whole number.' };
			return { kind: 'set', value: number };
		}
		case 'tags':
			return {
				kind: 'set',
				value: [
					...new Set(
						text
							.split(',')
							.map((tag) => tag.trim())
							.filter((tag) => tag !== ''),
					),
				],
			};
		case 'json':
			try {
				return { kind: 'set', value: JSON.parse(text) };
			} catch (error) {
				return {
					kind: 'invalid',
					message: `This is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		case 'date':
		case 'instant':
		case 'datetime':
		case 'url':
		case 'reference':
			return { kind: 'set', value: trimmed };
		case 'string':
			return { kind: 'set', value: text };
	}
}

/** A stored value as one line of a grid cell. */
export function displayOf(value: unknown): string {
	if (value === undefined) return '';
	if (typeof value === 'string') return value;
	if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
		return value.join(', ');
	return JSON.stringify(value);
}
