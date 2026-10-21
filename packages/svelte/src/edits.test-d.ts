/**
 * Type tests for the Svelte edit bindings, checked by `svelte-check`; never
 * run. A binding is made from a table and an id, or the folder's files and a
 * path, and tracks the folder edit through getters; `row` keeps the
 * schema's precision and is optional until read. A change is nested fields
 * and body; no source is named.
 */
import { expectTypeOf } from 'bun:test';
import type { Folder, Row } from '@epicenter/folder';
import type { Pending, ReadStatus } from '@epicenter/folder/edits';
import { Type } from 'typebox';
import { createRowEdit, createTextEdit } from './edits.js';

const notes = Type.Object({ title: Type.String(), done: Type.Boolean() });
type Note = Row<typeof notes>;

declare const folder: Folder<{ notes: typeof notes }>;

const rowEdit = createRowEdit(folder.tables.notes, 'milk');
expectTypeOf(rowEdit.path).toEqualTypeOf<string>();
expectTypeOf(rowEdit.row).toEqualTypeOf<Note | undefined>();
expectTypeOf(rowEdit.readStatus).toEqualTypeOf<ReadStatus>();
expectTypeOf(rowEdit.pending).toEqualTypeOf<
	Pending<typeof notes> | undefined
>();
expectTypeOf(rowEdit.locked).toEqualTypeOf<boolean>();
const row = rowEdit.row;
if (row?.issues === null)
	expectTypeOf(row.fields.title).toEqualTypeOf<string>();
rowEdit.change({ fields: { title: 'Oat milk', done: true } });
rowEdit.change({ body: 'Two litres' });
rowEdit.change({ fields: { done: false }, body: 'Two litres' });
// @ts-expect-error A flat field is not a change.
rowEdit.change({ title: 'Oat milk' });
// @ts-expect-error A change names fields of the row's schema.
rowEdit.change({ fields: { titel: 'Oat milk' } });
// @ts-expect-error A field takes its schema's type.
rowEdit.change({ fields: { done: 'yes' } });
// @ts-expect-error Svelte reads the tracked property, without a duplicate method.
rowEdit.getRow();
// @ts-expect-error Reactive properties are readonly; changes go through commands.
rowEdit.row = undefined;
// @ts-expect-error A binding is made from a table, not a core rowEdit.
createRowEdit(folder.tables.notes.edit('milk'), () => undefined);

const textEdit = createTextEdit(folder.files, 'notes/a.md');
expectTypeOf(textEdit.text).toEqualTypeOf<string | undefined>();
expectTypeOf(textEdit.readStatus).toEqualTypeOf<ReadStatus>();
textEdit.change('whole text');
textEdit.changeFields({ title: 'x' });
// @ts-expect-error Svelte reads the tracked text property.
textEdit.getText();
// @ts-expect-error Reactive text is readonly.
textEdit.text = 'replacement';
// @ts-expect-error The whole text is a string.
textEdit.change(new Uint8Array());
