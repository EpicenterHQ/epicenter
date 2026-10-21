/** Schema precision survives the framework adapter. Checked, never run. */
import { expectTypeOf } from 'bun:test';
import type { Folder } from '@epicenter/folder';
import type {
	MarkdownContent,
	Pending,
	ReadStatus,
} from '@epicenter/folder/edits';
import { Type } from 'typebox';
import { useFileEdit } from './edits.js';

const notes = Type.Object({ title: Type.String(), done: Type.Boolean() });
declare const folder: Folder<{ notes: typeof notes }>;
const fileEdit = useFileEdit(folder.tables.notes.edit('milk'));
expectTypeOf(fileEdit.getMarkdown()).toEqualTypeOf<
	MarkdownContent<typeof notes> | undefined
>();
expectTypeOf(fileEdit.getText()).toEqualTypeOf<string | undefined>();
expectTypeOf(fileEdit.getReadStatus()).toEqualTypeOf<ReadStatus>();
expectTypeOf(fileEdit.getPending()).toEqualTypeOf<
	Pending<typeof notes> | undefined
>();
expectTypeOf(fileEdit.isLocked()).toEqualTypeOf<boolean>();
const markdown = fileEdit.getMarkdown();
if (markdown?.issues === null)
	expectTypeOf(markdown.fields.title).toEqualTypeOf<string>();
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
const generic = useFileEdit(folder.files.edit('arbitrary.md'));
generic.change({ fields: { anyName: 'value' } });
generic.replaceText('source');
// @ts-expect-error React reads are explicit methods.
fileEdit.markdown;
