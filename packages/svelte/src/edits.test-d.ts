/** Schema precision survives the framework adapter. Checked, never run. */
import { expectTypeOf } from 'bun:test';
import type { Folder } from '@epicenter/folder';
import type { BufferSnapshot, MarkdownContent } from '@epicenter/folder/edits';
import { Type } from 'typebox';
import { createFileEdit } from './edits.js';

const notes = Type.Object({ title: Type.String(), done: Type.Boolean() });
declare const folder: Folder<{ notes: typeof notes }>;
const fileEdit = createFileEdit(folder.tables.notes.edit('milk'));
expectTypeOf(fileEdit.markdown).toEqualTypeOf<
	MarkdownContent<typeof notes> | undefined
>();
expectTypeOf(fileEdit.text).toEqualTypeOf<string | undefined>();
expectTypeOf(fileEdit.buffer).toEqualTypeOf<BufferSnapshot>();
expectTypeOf(fileEdit.locked).toEqualTypeOf<boolean>();
const markdown = fileEdit.markdown;
if (markdown?.issues === null)
	expectTypeOf(markdown.fields?.title).toEqualTypeOf<string>();
fileEdit.change({ fields: { title: 'Oat milk', done: true } });
fileEdit.change({ body: 'Two litres' });
fileEdit.change({ fields: { done: false }, body: 'Two litres' });
fileEdit.replaceText('whole source');
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
generic.replaceText('source');
// @ts-expect-error Svelte exposes a tracked property, not a second read method.
fileEdit.getMarkdown();
// @ts-expect-error Tracked reads are readonly.
fileEdit.markdown = undefined;

// A captured snapshot narrows content and save feedback together.
const buffer = fileEdit.buffer;
if (buffer.status === 'ready') {
	expectTypeOf(buffer.text).toEqualTypeOf<string>();
	if (buffer.unsaved?.status === 'conflict')
		expectTypeOf(buffer.unsaved.error.name).toEqualTypeOf<'Conflict'>();
} else {
	// @ts-expect-error Nonready buffers have no editable text.
	buffer.text;
	// @ts-expect-error Unsaved input always belongs to a ready buffer.
	buffer.unsaved;
}
