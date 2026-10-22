/** Schema precision survives the framework adapter. Checked, never run. */
import { expectTypeOf } from 'bun:test';
import type { Folder, SaveError } from '@epicenter/folder';
import type {
	DocumentSnapshot,
	LoadError,
	MarkdownContent,
} from '@epicenter/folder/document';
import { Type } from 'typebox';
import { useDocument } from './document.js';

const notes = Type.Object({ title: Type.String(), done: Type.Boolean() });
declare const folder: Folder<{ notes: typeof notes }>;
export function useTypeAssertions() {
	const edit = folder.tables.notes.document('milk');
	const snapshot = useDocument(edit);
	expectTypeOf(snapshot).toEqualTypeOf<DocumentSnapshot<typeof notes>>();
	expectTypeOf(snapshot.content).toEqualTypeOf<
		MarkdownContent<typeof notes> | undefined
	>();
	expectTypeOf(snapshot.loadError).toEqualTypeOf<LoadError | undefined>();
	expectTypeOf(snapshot.saveError).toEqualTypeOf<SaveError | undefined>();
	expectTypeOf(snapshot.isDirty).toEqualTypeOf<boolean>();
	expectTypeOf(snapshot.isSaving).toEqualTypeOf<boolean>();
	if (snapshot.content?.issues === null)
		expectTypeOf(snapshot.content.fields.title).toEqualTypeOf<string>();
	edit.patch({ fields: { title: 'Oat milk', done: true } });
	// @ts-expect-error A change names fields of this edit's schema.
	edit.patch({ fields: { titel: 'Oat milk' } });
	// @ts-expect-error Commands stay on the editor handle.
	snapshot.replace('source');
	// @ts-expect-error The snapshot is immutable.
	snapshot.isDirty = true;
	const generic = useDocument(folder.files.document('arbitrary.md'));
	expectTypeOf(generic.content?.fields).toEqualTypeOf<
		{ readonly [key: string]: unknown } | undefined
	>();
	// Content is readonly all the way down, as the frozen snapshot is.
	if (snapshot.content?.issues === null)
		// @ts-expect-error A field of the snapshot cannot be assigned.
		snapshot.content.fields.title = 'Oat milk';
}
