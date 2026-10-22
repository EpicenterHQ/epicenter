/** Schema precision survives the framework adapter. Checked, never run. */
import { expectTypeOf } from 'bun:test';
import type { Folder, SaveError } from '@epicenter/folder';
import type {
	EditorSnapshot,
	LoadError,
	MarkdownContent,
} from '@epicenter/folder/edits';
import { Type } from 'typebox';
import { useFileEdit } from './edits.js';

const notes = Type.Object({ title: Type.String(), done: Type.Boolean() });
declare const folder: Folder<{ notes: typeof notes }>;
export function useTypeAssertions() {
	const edit = folder.tables.notes.edit('milk');
	const snapshot = useFileEdit(edit);
	expectTypeOf(snapshot).toEqualTypeOf<EditorSnapshot<typeof notes>>();
	expectTypeOf(snapshot.content).toEqualTypeOf<
		MarkdownContent<typeof notes> | undefined
	>();
	expectTypeOf(snapshot.loadError).toEqualTypeOf<LoadError | undefined>();
	expectTypeOf(snapshot.saveError).toEqualTypeOf<SaveError | undefined>();
	expectTypeOf(snapshot.isDirty).toEqualTypeOf<boolean>();
	expectTypeOf(snapshot.isSaving).toEqualTypeOf<boolean>();
	if (snapshot.content?.issues === null)
		expectTypeOf(snapshot.content.fields.title).toEqualTypeOf<string>();
	edit.change({ fields: { title: 'Oat milk', done: true } });
	// @ts-expect-error A change names fields of this edit's schema.
	edit.change({ fields: { titel: 'Oat milk' } });
	// @ts-expect-error Commands stay on the editor handle.
	snapshot.replaceText('source');
	// @ts-expect-error The snapshot is immutable.
	snapshot.isDirty = true;
	const generic = useFileEdit(folder.files.edit('arbitrary.md'));
	expectTypeOf(generic.content?.fields).toEqualTypeOf<
		{ readonly [key: string]: unknown } | undefined
	>();
	// Content is readonly all the way down, as the frozen snapshot is.
	if (snapshot.content?.issues === null)
		// @ts-expect-error A field of the snapshot cannot be assigned.
		snapshot.content.fields.title = 'Oat milk';
}
