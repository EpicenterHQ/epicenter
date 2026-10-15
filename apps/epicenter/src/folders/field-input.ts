/**
 * How the Folders window edits one declared field: which editor its schema
 * gets (`fieldEditorOf`), how an editor's text becomes the value saved, the
 * update a change sends (`fieldUpdate`), and what a person is told when it
 * was not saved (`failureText`).
 *
 * The editor follows the field's `x-field` hint where the schema has that
 * widget's shape. A field with no hint at all, as a hand-written plain JSON
 * Schema declares it, gets the editor its type implies (`plainKind`); any
 * other field gets the JSON editor. Text editors cover every
 * kind but boolean, select, and multiSelect, which save values directly.
 * Dates are `YYYY-MM-DD`; instants and datetimes are edited as their ISO
 * text, since a `datetime-local` input would drop seconds and the offset.
 * The schema decides validity when the row is saved, so a value the editor
 * passes may still be refused there.
 */

import {
	FIELD_KEYWORD,
	type FieldEditor,
	type FieldHint,
	fieldEditorOf,
	isOptional,
} from '@epicenter/definition';
import type { PreparedFolderTable, TableUpdateError } from '@epicenter/folder';

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
		editor: editorOf(schema),
		optional: isOptional(schema),
	}));
}

type Schema = PreparedFolderTable['fields'][string];
type Keywords = Readonly<Record<string, unknown>>;

const isKeywords = (value: unknown): value is Keywords =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `schema`'s editor: its hint's, or, when neither it nor the member of its
 * union with `null` carries a hint, the one its plain type implies. A hint
 * that is present still wins, even when it resolves to the JSON editor.
 */
export function editorOf(schema: Schema): FieldEditor {
	const editor = fieldEditorOf(schema);
	const keywords = schema as unknown as Keywords;
	const subject = nullableMember(keywords) ?? keywords;
	if (
		editor.kind !== 'json' ||
		Object.hasOwn(keywords, FIELD_KEYWORD) ||
		Object.hasOwn(subject, FIELD_KEYWORD)
	)
		return editor;
	const kind = plainKind(subject);
	if (kind === undefined) return editor;
	// The hint goes through `fieldEditorOf`, so the same shape checks decide
	// whether the schema fits it; one that does not stays the JSON editor.
	return fieldEditorOf({
		...schema,
		[FIELD_KEYWORD]: { kind } satisfies FieldHint,
	} as Schema);
}

/** The member of `anyOf: [member, { type: 'null' }]`, in either order. */
function nullableMember(schema: Keywords): Keywords | undefined {
	const members = schema.anyOf;
	if (!Array.isArray(members) || members.length !== 2) return undefined;
	const rest = members.filter(
		(member) => !(isKeywords(member) && member.type === 'null'),
	);
	return rest.length === 1 && isKeywords(rest[0]) ? rest[0] : undefined;
}

/**
 * The editor kind a plain JSON Schema's type implies: a checkbox for
 * `boolean`, a number box for `integer` and `number`, a menu for a string
 * `enum`, a date input for a `date` string, ISO text for a `date-time` one
 * (a date input would drop the time), a URL box for a `uri` one, toggles for
 * an array of a string `enum`, tags for an array of strings, and a text box
 * for any other string. `undefined` for anything else.
 */
function plainKind(
	schema: Keywords,
): Exclude<FieldHint['kind'], 'reference'> | undefined {
	if (Array.isArray(schema.enum)) return 'select';
	switch (schema.type) {
		case 'boolean':
		case 'integer':
		case 'number':
			return schema.type;
		case 'string':
			switch (schema.format) {
				case 'date':
					return 'date';
				case 'date-time':
					return 'datetime';
				case 'uri':
					return 'url';
				default:
					return 'string';
			}
		case 'array':
			if (!isKeywords(schema.items)) return undefined;
			if (Array.isArray(schema.items.enum)) return 'multiSelect';
			return schema.items.type === 'string' ? 'tags' : undefined;
		default:
			return undefined;
	}
}

/** What an edit does to one field: set its value, or leave it out of the row. */
export type FieldChange =
	| { readonly kind: 'set'; readonly value: unknown }
	| { readonly kind: 'remove' };

/**
 * The update `change` to `field` sends (ADR-0554): set its value, or unset
 * it. The value is set by definition, so any field name is an own key.
 */
export function fieldUpdate(
	field: string,
	change: FieldChange,
): { readonly set?: Record<string, unknown>; readonly unset?: string[] } {
	if (change.kind === 'remove') return { unset: [field] };
	const set: Record<string, unknown> = {};
	Object.defineProperty(set, field, {
		value: change.value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
	return { set };
}

/**
 * Why a write wrote nothing, for a person. A write mutation rejects with
 * the table's error; anything else that threw is said as its message.
 */
export function failureText(error: unknown): string {
	if (!isTableError(error))
		return `Not saved: ${error instanceof Error ? error.message : String(error)}`;
	switch (error.name) {
		case 'InvalidValues':
			return `Not saved: ${error.issues.map((issue) => issue.message).join('; ')}`;
		case 'NotFound':
			return 'Another window deleted this row, so your edit was not saved.';
		case 'InvalidRow':
			return 'Another window saved this row in a form that does not read as a row, so your edit was not saved.';
		case 'KeptChanging':
			return 'This row kept changing in another window, so your edit was not saved.';
		default:
			return `Not saved: ${error.message}`;
	}
}

function isTableError(error: unknown): error is TableUpdateError {
	return (
		typeof error === 'object' &&
		error !== null &&
		typeof (error as { name?: unknown }).name === 'string' &&
		typeof (error as { message?: unknown }).message === 'string'
	);
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
