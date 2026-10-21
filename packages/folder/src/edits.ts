/**
 * `@epicenter/folder/edits`: the vocabulary of editable documents over an
 * opened folder, whose handles are `folder.tables.<name>.edit(id)` and
 * `folder.files.edit(path)` (`edit-owner.ts` states the rules), and the
 * folder's line merge of whole texts. The folder owns each path's document
 * and input for its whole life: `folder.getStatus()`, `folder.settle()` and
 * `folder.close()` report and send the input. Importing it opens nothing.
 */
export {
	ActionError,
	type AnyFieldsSchema,
	BUSY,
	ChangeError,
	type ChangeResult,
	CLOSING,
	DELETING,
	type DeleteResult,
	type DocumentChange,
	type FileEdit,
	type MarkdownContent,
	mergeFileText,
	mergeText,
	type BufferSnapshot,
	type BufferIssue,
	type Unsaved,
	type Recovery,
	type SaveFailure,
	type SaveFailureRecovery,
	type SaveConflict,
	SourceUnavailable,
	SAVE_AFTER_MS,
	UNSAVED,
} from './edit-owner.js';
