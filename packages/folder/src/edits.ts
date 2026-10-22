/**
 * `@epicenter/folder/edits`: the vocabulary of the editors over an opened
 * folder, `folder.tables.<name>.edit(id)` and `folder.files.edit(path)`
 * (`edit-owner.ts` states the rules). The folder owns each path's one source
 * and its input for its whole life: `folder.getStatus()`, `folder.settle()`
 * and `folder.close()` report and send the input. Importing it opens nothing.
 */
export {
	ActionError,
	type AnyFieldsSchema,
	ChangeError,
	type ChangeResult,
	CLOSING,
	type DocumentChange,
	type EditorSnapshot,
	type FileEdit,
	LoadError,
	type MarkdownContent,
	type Recovery,
	SAVE_AFTER_MS,
	SaveRefusal,
} from './edit-owner.js';
