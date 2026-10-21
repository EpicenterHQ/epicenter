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
	BUSY,
	ChangeError,
	type ChangeResult,
	CLOSING,
	DELETING,
	type DeleteResult,
	type ExclusiveFile,
	type FieldsPending,
	mergeText,
	type Pending,
	type ReadStatus,
	type RowEdit,
	type RowEditChange,
	type RowPending,
	SAVE_AFTER_MS,
	type TextEdit,
	type TextPending,
	UNSAVED,
} from './edit-owner.js';
