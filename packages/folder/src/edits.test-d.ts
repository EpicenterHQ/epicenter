/**
 * Edit handle types: an edit answers its own document through literal
 * methods, a row change is nested fields and body checked against the
 * table's schema, and no source is named. An admitted action takes no
 * argument and answers its own result. Checked by `tsc`, never run.
 */
import { expectTypeOf } from 'bun:test';
import { Type } from 'typebox';
import type { Result } from 'wellcrafted/result';
import type {
	ActionError,
	ChangeResult,
	DocumentChange,
	MarkdownContent,
	Pending,
	ReadStatus,
} from './edits.js';
import type { Folder, ReadError, Row } from './folder.js';

const notes = Type.Object({ title: Type.String(), body: Type.String() });
declare const folder: Folder<{ notes: typeof notes }>;
declare const row: Row<typeof notes>;

const edit = folder.tables.notes.edit('a');
expectTypeOf(edit.path).toEqualTypeOf<string>();
expectTypeOf(edit.getMarkdown()).toEqualTypeOf<
	MarkdownContent<typeof notes> | undefined
>();
expectTypeOf(edit.getPending()).toEqualTypeOf<Pending | undefined>();
const pending = edit.getPending();
if (pending?.kind === 'document')
	expectTypeOf(pending.fields).toEqualTypeOf<
		Readonly<Record<string, unknown>>
	>();
const markdown = edit.getMarkdown();
if (markdown?.issues === null)
	expectTypeOf(markdown.fields).toEqualTypeOf<{
		title: string;
		body: string;
	}>();
expectTypeOf(edit.isLocked()).toEqualTypeOf<boolean>();
expectTypeOf(edit.getReadStatus()).toEqualTypeOf<ReadStatus>();
expectTypeOf<ReadStatus>().toEqualTypeOf<{
	readonly known: 'nothing' | 'missing' | 'file' | 'not-text';
	readonly reading: boolean;
	readonly error: ReadError | undefined;
}>();
expectTypeOf(edit.read()).toEqualTypeOf<Promise<Result<void, ReadError>>>();
expectTypeOf(
	edit.change({ fields: { title: 'x' } }),
).toEqualTypeOf<ChangeResult>();
edit.change({ body: 'the row body' });
edit.change({ fields: { title: 'x', body: 'a field named body' }, body: 'y' });
// @ts-expect-error A source is no longer named.
edit.change(row, { fields: { title: 'x' } });
// @ts-expect-error A flat field is not a change.
edit.change({ title: 'x' });
// @ts-expect-error A field outside the schema is not typed.
edit.change({ fields: { other: 1 } });
// @ts-expect-error A field keeps its schema type.
edit.change({ fields: { title: 1 } });
// @ts-expect-error The body is text.
edit.change({ body: 1 });
// @ts-expect-error There is no separate body command.
edit.changeBody('x');
// @ts-expect-error There is no projection over an observed source.
edit.shown(row);
// @ts-expect-error Held input is read through `getPending()`.
edit.pending;
expectTypeOf<DocumentChange<typeof notes>>().toEqualTypeOf<{
	readonly fields?: Readonly<Partial<{ title: string; body: string }>>;
	readonly body?: string;
}>();

const text = folder.files.edit('a.md');
expectTypeOf(text.getText()).toEqualTypeOf<string | undefined>();
expectTypeOf(text.getPending()).toEqualTypeOf<Pending | undefined>();
expectTypeOf(text.read()).toEqualTypeOf<Promise<Result<void, ReadError>>>();
text.replaceText('x');
// @ts-expect-error A source is no longer named.
text.change(new Uint8Array(), 'x');
text.change({ fields: { anything: null } });

expectTypeOf(folder.close()).toEqualTypeOf<
	Promise<import('./edits.js').Pending[]>
>();
expectTypeOf(
	folder.run(['notes/a.md', 'audio/a.bin'], async () => {
		expectTypeOf(await folder.tables.notes.get('a')).toEqualTypeOf<
			Result<Row<typeof notes> | undefined, ReadError>
		>();
		return 'done';
	}),
).toEqualTypeOf<Promise<Result<string, ActionError>>>();
// @ts-expect-error An action is handed nothing; it uses this same Folder.
folder.run([], async (work: unknown) => work);
// @ts-expect-error Close is the single shutdown fence.
folder.stopEditing();
// @ts-expect-error Reservations belong to folder.run.
folder.files.exclusive(['notes/a.md'], async () => {});
// @ts-expect-error Reservations belong to folder.run.
edit.exclusive(async () => {});
