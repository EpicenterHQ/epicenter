/**
 * Type tests for the React edit hooks, checked by `tsc`; never run. A hook
 * is given a table and an id, or the folder's files and a path, and answers
 * the folder edit's methods; `getRow()` keeps the schema's precision and is
 * optional until read. A change is nested fields and body; no source is
 * named.
 */
import { expectTypeOf } from 'bun:test';
import type { Folder, Row } from '@epicenter/folder';
import type { Pending, ReadStatus } from '@epicenter/folder/edits';
import { Type } from 'typebox';
import { useRowEdit, useTextEdit } from './edits.js';

const notes = Type.Object({ title: Type.String(), done: Type.Boolean() });
type Note = Row<typeof notes>;

declare const folder: Folder<{ notes: typeof notes }>;

const note = useRowEdit(folder.tables.notes, 'milk');
expectTypeOf(note.getRow()).toEqualTypeOf<Note | undefined>();
expectTypeOf(note.getReadStatus()).toEqualTypeOf<ReadStatus>();
expectTypeOf(note.getPending()).toEqualTypeOf<
	Pending<typeof notes> | undefined
>();
expectTypeOf(note.isLocked()).toEqualTypeOf<boolean>();
const row = note.getRow();
if (row?.issues === null)
	expectTypeOf(row.fields.title).toEqualTypeOf<string>();
note.change({ fields: { title: 'Oat milk', done: true } });
note.change({ body: 'Two litres' });
note.change({ fields: { done: false }, body: 'Two litres' });
// @ts-expect-error A flat field is not a change.
note.change({ title: 'Oat milk' });
// @ts-expect-error A change names fields of the row's schema.
note.change({ fields: { titel: 'Oat milk' } });
// @ts-expect-error A field takes its schema's type.
note.change({ fields: { done: 'yes' } });
// @ts-expect-error The row is read through `getRow()`.
note.row;
// @ts-expect-error A hook is given a table, not a core edit and an observed row.
useRowEdit(folder.tables.notes.edit('milk'), undefined);

const text = useTextEdit(folder.files, 'notes/a.md');
expectTypeOf(text.getText()).toEqualTypeOf<string | undefined>();
text.change('whole text');
// @ts-expect-error The whole text is a string.
text.change(new Uint8Array());
