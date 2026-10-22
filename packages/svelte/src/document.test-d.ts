/** Schema precision survives the framework adapter. Checked, never run. */
import { expectTypeOf } from 'bun:test';
import type { Folder, SaveError } from '@epicenter/folder';
import type { LoadError, MarkdownContent } from '@epicenter/folder/document';
import { Type } from 'typebox';
import { reactiveDocument } from './document.js';

const notes = Type.Object({
	title: Type.String(),
	done: Type.Boolean(),
	tags: Type.Array(Type.String()),
});
declare const folder: Folder<{ notes: typeof notes }>;
const fileEdit = reactiveDocument(folder.tables.notes.document('milk'));
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
	fileEdit.patch({ fields: content.fields });
	// @ts-expect-error Frozen nested arrays cannot be changed in place.
	content.fields.tags.push('new');
}
fileEdit.patch({ fields: { title: 'Oat milk', done: true } });
fileEdit.patch({ body: 'Two litres' });
fileEdit.replace('whole source');
fileEdit.save({ fields: { done: true } });
fileEdit.save('whole source');
// @ts-expect-error Patches accept fields and body, not complete text.
fileEdit.patch({ text: 'source', body: 'body' });
// @ts-expect-error A replacement accepts a string, not a patch object.
fileEdit.replace({ body: 'body' });
// @ts-expect-error Full-source publication accepts a string, not a text envelope.
fileEdit.save({ text: 'source' });
// @ts-expect-error A patch accepts an object, not complete source.
fileEdit.patch('whole source');
expectTypeOf(fileEdit.discard()).toEqualTypeOf<string | undefined>();
// @ts-expect-error A flat field is not a markdown change.
fileEdit.patch({ title: 'Oat milk' });
// @ts-expect-error A change names fields of this edit's schema.
fileEdit.patch({ fields: { titel: 'Oat milk' } });
// @ts-expect-error A field takes its schema's type.
fileEdit.patch({ fields: { done: 'yes' } });
// @ts-expect-error Source replacement takes text.
fileEdit.replace(new Uint8Array());
const generic = reactiveDocument(folder.files.document('arbitrary.md'));
generic.patch({ fields: { anyName: 'value' } });
// @ts-expect-error Svelte exposes tracked properties, not the snapshot method.
fileEdit.getSnapshot();
// @ts-expect-error Tracked reads are readonly.
fileEdit.content = undefined;
// @ts-expect-error The removed storage and buffer shapes are gone.
fileEdit.buffer;
// @ts-expect-error Nothing locks input.
fileEdit.locked;
