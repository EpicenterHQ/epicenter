/**
 * `@epicenter/definition/contract`: an app's file layout as plain data, the
 * typed client it derives, the path functions every opener shares, the
 * check `epicenter check` runs, and a note as text (`noteText`,
 * `readNoteText`) for apps that edit one whole.
 */
export { checkContract, type FileIssue } from './check.js';
export {
	type Client,
	ClientError,
	type CollectionClient,
	type FieldsOf,
	type FileClient,
	type FileEntryOf,
	type FileOf,
	type InvalidNoteOf,
	type NoteClient,
	type NoteOf,
	type NotePatch,
	type Over,
	type PlaceholdersOf,
	type Subscribe,
	type Version,
} from './client.js';
export {
	type Collection,
	type CompiledCollection,
	type CompiledContract,
	type Contract,
	ContractError,
	compileContract,
	defineContract,
} from './contract.js';
export { noteText, readNoteText } from './note-text.js';
export {
	EPICENTER_BLOCK_BEGIN,
	EPICENTER_BLOCK_END,
	isHiddenPath,
	isNotePath,
	REPOSITORY_ATTRIBUTES,
	REPOSITORY_IGNORE,
	storedWithLfs,
} from './storage.js';
export {
	compileTemplate,
	fill,
	isFilePath,
	isNoteTemplate,
	match,
	type Params,
	type Segment,
	type Template,
	TemplateError,
	templatesOverlap,
} from './templates.js';
export { updateNote } from './update-note.js';
