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
	BufferSnapshot,
	Recovery,
	Unsaved,
} from './edits.js';
import type { Folder, ReadError, Row, SaveError } from './folder.js';

const notes = Type.Object({ title: Type.String(), body: Type.String() });
declare const folder: Folder<{ notes: typeof notes }>;
declare const row: Row<typeof notes>;

const edit = folder.tables.notes.edit('a');
expectTypeOf(edit.path).toEqualTypeOf<string>();
expectTypeOf(edit.getMarkdown()).toEqualTypeOf<
	MarkdownContent<typeof notes> | undefined
>();
expectTypeOf(edit.getBuffer()).toEqualTypeOf<BufferSnapshot>();
const buffer = edit.getBuffer();
if (buffer.status === 'ready') {
	expectTypeOf(buffer.text).toEqualTypeOf<string>();
	expectTypeOf(buffer.unsaved).toEqualTypeOf<Unsaved | undefined>();
	if (buffer.unsaved?.status === 'conflict')
		expectTypeOf(buffer.unsaved.error.name).toEqualTypeOf<'Conflict'>();
} else {
	// @ts-expect-error Nonready buffers have no editable source.
	buffer.text;
	// @ts-expect-error Held input always belongs to a ready buffer.
	buffer.unsaved;
}
const markdown = edit.getMarkdown();
if (markdown?.issues === null)
	expectTypeOf(markdown.fields).toEqualTypeOf<{
		title: string;
		body: string;
	}>();
expectTypeOf(edit.isLocked()).toEqualTypeOf<boolean>();
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
// @ts-expect-error Vanilla reads are explicit methods.
edit.buffer;
// @ts-expect-error Unsaved input belongs to the ready buffer.
edit.getPending();
// @ts-expect-error Read availability belongs to the buffer.
edit.getReadStatus();
expectTypeOf<DocumentChange<typeof notes>>().toEqualTypeOf<{
	readonly fields?: Readonly<Partial<{ title: string; body: string }>>;
	readonly body?: string;
}>();

const text = folder.files.edit('a.md');
expectTypeOf(text.getText()).toEqualTypeOf<string | undefined>();
expectTypeOf(text.getBuffer()).toEqualTypeOf<BufferSnapshot>();
expectTypeOf(text.read()).toEqualTypeOf<Promise<Result<void, ReadError>>>();
text.replaceText('x');
// @ts-expect-error A source is no longer named.
text.change(new Uint8Array(), 'x');
text.change({ fields: { anything: null } });

expectTypeOf(folder.close()).toEqualTypeOf<Promise<Recovery[]>>();
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

expectTypeOf(edit.discard()).toEqualTypeOf<
	Result<Recovery | undefined, ActionError>
>();
expectTypeOf(edit.save()).toEqualTypeOf<
	Promise<Result<void, SaveError | ActionError>>
>();

expectTypeOf(edit.resolveConflict('current')).toEqualTypeOf<
	Promise<Result<void, ReadError | SaveError | ActionError>>
>();
