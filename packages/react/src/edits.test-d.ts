/**
 * Type tests for the React edit hooks, checked by `tsc`; never run. A
 * definite observed source gives a definite `row` or `text` with the schema's
 * precision; a source that can be `undefined` gives an optional one. A
 * change is nested fields and body; the flat patch and `changeBody` are gone.
 */
import { expectTypeOf } from 'bun:test';
import type { Row } from '@epicenter/folder';
import type { RowEdit, RowPending, TextEdit } from '@epicenter/folder/edits';
import { Type } from 'typebox';
import { useRowEdit, useTextEdit } from './edits.js';

const notes = Type.Object({ title: Type.String(), done: Type.Boolean() });
type Note = Row<typeof notes>;
type ValidNote = Extract<Note, { issues: null }>;

declare const rowEdit: RowEdit<typeof notes>;
declare const valid: ValidNote;
declare const listed: Note;
declare const loading: ValidNote | undefined;

const definite = useRowEdit(rowEdit, valid);
expectTypeOf(definite.row).toEqualTypeOf<ValidNote>();
expectTypeOf(definite.row.fields.title).toEqualTypeOf<string>();
expectTypeOf(useRowEdit(rowEdit, listed).row).toEqualTypeOf<Note>();
expectTypeOf(useRowEdit(rowEdit, loading).row).toEqualTypeOf<
	ValidNote | undefined
>();
// Held input is readable whether or not a row is observed.
expectTypeOf(useRowEdit(rowEdit, undefined).pending).toEqualTypeOf<
	RowPending<typeof notes> | undefined
>();
definite.change({ fields: { title: 'Oat milk', done: true } });
definite.change({ body: 'Two litres' });
definite.change({ fields: { done: false }, body: 'Two litres' });
// @ts-expect-error A flat field is not a change.
definite.change({ title: 'Oat milk' });
// @ts-expect-error A change names fields of the row's schema.
definite.change({ fields: { titel: 'Oat milk' } });
// @ts-expect-error A field takes its schema's type.
definite.change({ fields: { done: 'yes' } });
// @ts-expect-error There is no separate body command.
definite.changeBody('Two litres');

declare const textEdit: TextEdit;
declare const bytes: Uint8Array;
declare const reading: Uint8Array | undefined;
expectTypeOf(useTextEdit(textEdit, bytes).text).toEqualTypeOf<string>();
expectTypeOf(useTextEdit(textEdit, reading).text).toEqualTypeOf<
	string | undefined
>();
// @ts-expect-error The observed source is bytes, not text.
useTextEdit(textEdit, 'source');
