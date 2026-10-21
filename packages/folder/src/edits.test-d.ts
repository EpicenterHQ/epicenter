/**
 * Edit handle types: an edit answers its own document through literal
 * methods, a row change is nested fields and body checked against the
 * table's schema, and no source is named. FolderWork retains typed storage
 * without input or lifecycle methods. Checked by `tsc`, never run.
 */
import { expectTypeOf } from 'bun:test';
import type { FolderWork as PublicFolderWork } from '@epicenter/folder';
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
import type { Folder, FolderWork, ReadError, Row } from './folder.js';

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
expectTypeOf<PublicFolderWork<{ notes: typeof notes }>>().toEqualTypeOf<
	FolderWork<{ notes: typeof notes }>
>();
expectTypeOf(
	folder.run(['notes/a.md', 'audio/a.bin'], async (work) => {
		expectTypeOf(work).toEqualTypeOf<FolderWork<{ notes: typeof notes }>>();
		expectTypeOf(work.files.read('notes/a.md')).toEqualTypeOf<
			ReturnType<typeof folder.files.read>
		>();
		expectTypeOf(work.tables.notes.get('a')).toEqualTypeOf<
			Promise<Result<Row<typeof notes> | undefined, ReadError>>
		>();
		// @ts-expect-error Only Folder admits actions; admitted work has no child run.
		work.run([], async () => 42);
		// @ts-expect-error Admitted work exposes storage, not editable input.
		work.files.edit('notes/a.md');
		// @ts-expect-error Admitted table work exposes storage, not editable input.
		work.tables.notes.edit('a');
		// @ts-expect-error Admitted work does not own the folder lifecycle.
		work.close();
		// @ts-expect-error Settling inside admitted work would wait for itself.
		work.settle();
		// @ts-expect-error Admitted work does not expose folder listeners.
		work.onChange(() => {});
		// @ts-expect-error Unknown tables remain unavailable in admitted work.
		work.tables.unknown.get('a');
		return 'done';
	}),
).toEqualTypeOf<Promise<Result<string, ActionError>>>();
// @ts-expect-error Close is the single shutdown fence.
folder.stopEditing();
// @ts-expect-error Reservations belong to folder.run.
folder.files.exclusive(['notes/a.md'], async () => {});
// @ts-expect-error Reservations belong to folder.run.
edit.exclusive(async () => {});

// @ts-expect-error The root handle cannot stand in for an admitted capability.
const unadmitted: FolderWork<{ notes: typeof notes }> = folder;
void unadmitted;
