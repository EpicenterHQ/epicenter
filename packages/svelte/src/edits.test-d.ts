/** Schema precision survives the framework adapter. Checked, never run. */
import { expectTypeOf } from 'bun:test';
import type { Folder, SaveError } from '@epicenter/folder';
import type { LoadError, MarkdownContent } from '@epicenter/folder/edits';
import { Type } from 'typebox';
import { createFileEdit } from './edits.js';

const notes = Type.Object({
	title: Type.String(),
	done: Type.Boolean(),
	tags: Type.Array(Type.String()),
});
declare const folder: Folder<{ notes: typeof notes }>;
const fileEdit = createFileEdit(folder.tables.notes.edit('milk'));
expectTypeOf(fileEdit.content).toEqualTypeOf<
	MarkdownContent<typeof notes> | undefined
>();
expectTypeOf(fileEdit.loadError).toEqualTypeOf<LoadError | undefined>();
expectTypeOf(fileEdit.saveError).toEqualTypeOf<SaveError | undefined>();
expectTypeOf(fileEdit.isDirty).toEqualTypeOf<boolean>();
expectTypeOf(fileEdit.isSaving).toEqualTypeOf<boolean>();
const content = fileEdit.content;
if (content?.issues === null) {
	expectTypeOf(content.fields.title).toEqualTypeOf<string>();
	expectTypeOf(content.text).toEqualTypeOf<string>();
	// Frozen fields are valid input without cloning nested values.
	fileEdit.change({ fields: content.fields });
	// @ts-expect-error Frozen nested arrays cannot be changed in place.
	content.fields.tags.push('new');
}
fileEdit.change({ fields: { title: 'Oat milk', done: true } });
fileEdit.change({ body: 'Two litres' });
fileEdit.replaceText('whole source');
expectTypeOf(fileEdit.discard()).toEqualTypeOf<string | undefined>();
// @ts-expect-error A flat field is not a markdown change.
fileEdit.change({ title: 'Oat milk' });
// @ts-expect-error A change names fields of this edit's schema.
fileEdit.change({ fields: { titel: 'Oat milk' } });
// @ts-expect-error A field takes its schema's type.
fileEdit.change({ fields: { done: 'yes' } });
// @ts-expect-error Source replacement takes text.
fileEdit.replaceText(new Uint8Array());
const generic = createFileEdit(folder.files.edit('arbitrary.md'));
generic.change({ fields: { anyName: 'value' } });
// @ts-expect-error Svelte exposes tracked properties, not the snapshot method.
fileEdit.getSnapshot();
// @ts-expect-error Tracked reads are readonly.
fileEdit.content = undefined;
// @ts-expect-error The removed storage and buffer shapes are gone.
fileEdit.buffer;
// @ts-expect-error Nothing locks input.
fileEdit.locked;
