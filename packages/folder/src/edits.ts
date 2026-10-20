/**
 * `@epicenter/folder/edits`: the vocabulary of unsaved input over an opened
 * folder, whose handles are `folder.tables.<name>.edit(id)` and
 * `folder.files.edit(path)` (`edit-owner.ts` states the rules). The folder
 * owns that input for its whole life: `folder.status`, `folder.settle()` and
 * `folder.close()` report and send it. Importing it opens nothing.
 */
export {
	ActionError,
	BUSY,
	CLOSING,
	DELETING,
	type DeleteResult,
	type ExclusiveFile,
	type FieldsPending,
	type Pending,
	type RowEdit,
	type RowEditChange,
	type RowPending,
	type RowShown,
	SAVE_AFTER_MS,
	type TextEdit,
	type TextPending,
	type TextShown,
	UNSAVED,
} from './edit-owner.js';
