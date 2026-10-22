/**
 * `@epicenter/folder/document`: the shared working documents of an opened
 * folder, `folder.tables.<name>.document(id)` and `folder.files.document(path)`
 * (`document-owner.ts` states the rules). The folder owns each path's one source
 * and its input for its whole life: `folder.getStatus()`, `folder.flush()`
 * report and submit input; `folder.close()` releases the folder synchronously.
 * Importing it opens nothing.
 */
export {
	ActionError,
	type AnyFieldsSchema,
	ChangeError,
	type ChangeResult,
	CLOSING,
	type DocumentPatch,
	type DocumentSnapshot,
	type FileDocument,
	LoadError,
	type MarkdownContent,
	SAVE_AFTER_MS,
	type SaveFailure,
} from './document-owner.js';
