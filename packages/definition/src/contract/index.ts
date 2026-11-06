/**
 * `@epicenter/definition/contract`: an app's file layout as plain data, the
 * shapes of the notes and files it derives, the path functions every opener shares, the
 * check `epicenter check` runs, the collections `epicenter init` proposes
 * from a folder's files, and a note as text (`noteText`, `readNoteText`) for
 * apps that edit one whole.
 */
export { checkContract, type FileIssue } from './check.js';
export {
	ClientError,
	type FieldsOf,
	type FileEntryOf,
	type FileOf,
	type InvalidNoteOf,
	type NoteOf,
	type NotePatch,
	type PlaceholdersOf,
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
export { type ConformanceIssue, describeIssues } from './issues.js';
export { noteText, readNoteText } from './note-text.js';
export {
	EPICENTER_JSON_SCHEMA,
	type Proposal,
	proposeContract,
	type Unproposed,
} from './propose.js';
export {
	CONTRACT_PATH,
	EPICENTER_BLOCK_BEGIN,
	EPICENTER_BLOCK_END,
	isHiddenPath,
	isNotePath,
	REPOSITORY_ATTRIBUTES,
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
