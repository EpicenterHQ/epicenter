/**
 * Edit handle types: a row change is nested fields and body, checked against
 * the table's schema, and the flat patch and `changeBody` are gone. Checked
 * by `tsc`, never run.
 */
import { expectTypeOf } from 'bun:test';
import { Type } from 'typebox';
import type { RowEditChange, RowShown, TextShown } from './edits.js';
import type { Folder, Row } from './folder.js';

const notes = Type.Object({ title: Type.String(), body: Type.String() });
declare const folder: Folder<{ notes: typeof notes }>;
declare const row: Row<typeof notes>;
declare const bytes: Uint8Array;

const edit = folder.tables.notes.edit('a');
edit.change(row, { fields: { title: 'x' } });
edit.change(row, { body: 'the row body' });
edit.change(row, { fields: { title: 'x', body: 'a field named body' }, body: 'y' });
// @ts-expect-error A flat field is not a change.
edit.change(row, { title: 'x' });
// @ts-expect-error A field outside the schema is not typed.
edit.change(row, { fields: { other: 1 } });
// @ts-expect-error A field keeps its schema type.
edit.change(row, { fields: { title: 1 } });
// @ts-expect-error The body is text.
edit.change(row, { body: 1 });
// @ts-expect-error There is no separate body command.
edit.changeBody(row, 'x');
expectTypeOf<RowEditChange<typeof notes>>().toEqualTypeOf<{
	readonly fields?: Readonly<Partial<{ title: string; body: string }>>;
	readonly body?: string;
}>();
expectTypeOf(edit.shown(row)).toEqualTypeOf<RowShown<Row<typeof notes>>>();

const text = folder.files.edit('a.md');
expectTypeOf(text.shown(bytes)).toEqualTypeOf<TextShown>();
text.change(bytes, 'x');
text.change(undefined, 'x');
// @ts-expect-error A source is the bytes a view observed, not text.
text.change('a', 'x');
text.changeFields(bytes, { anything: null });

expectTypeOf(folder.close()).toEqualTypeOf<
	Promise<import('./edits.js').Pending[]>
>();
