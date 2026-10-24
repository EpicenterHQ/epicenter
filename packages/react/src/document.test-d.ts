/** Schema precision survives the framework adapter. Checked, never run. */
import { expectTypeOf } from 'bun:test';
import type { Folder, SaveError } from '@epicenter/folder';
import type {
	DocumentSnapshot,
	LoadError,
} from '@epicenter/folder/document';
import { Type } from 'typebox';
import { useDocument } from './document.js';

const notes = Type.Object({ title: Type.String(), done: Type.Boolean() });
declare const folder: Folder<{ notes: typeof notes }>;
export function useTypeAssertions() {
	const edit = folder.tables.notes.document('milk');
	const snapshot = useDocument(edit);
	expectTypeOf(snapshot).toEqualTypeOf<DocumentSnapshot>();
	expectTypeOf(snapshot.text).toEqualTypeOf<string | undefined>();
	expectTypeOf(snapshot.loadError).toEqualTypeOf<LoadError | undefined>();
	expectTypeOf(snapshot.saveError).toEqualTypeOf<SaveError | undefined>();
	expectTypeOf(snapshot.isDirty).toEqualTypeOf<boolean>();
	expectTypeOf(snapshot.isSaving).toEqualTypeOf<boolean>();
	if (snapshot.text !== undefined) {
		const parsed = folder.tables.notes.parse(snapshot.text);
		if (parsed.issues === null)
			expectTypeOf(parsed.fields.title).toEqualTypeOf<string>();
	}
	edit.patch({ fields: { title: 'Oat milk', done: true } });
	// @ts-expect-error A change names fields of this edit's schema.
	edit.patch({ fields: { titel: 'Oat milk' } });
	// @ts-expect-error Commands stay on the editor handle.
	snapshot.replace('source');
	const generic = useDocument(folder.files.document('arbitrary.md'));
	expectTypeOf(generic.text).toEqualTypeOf<string | undefined>();
}
