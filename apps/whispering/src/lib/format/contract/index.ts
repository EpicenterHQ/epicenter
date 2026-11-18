/**
 * Whispering's file format: a contract as plain data (its layout, the shapes
 * of the notes and files it derives, and the path functions), the check
 * `epicenter check` runs, and a note as text (`noteText`, `readNoteText`).
 * Whispering reads and writes its folder through these on top of `Files`.
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
	CONTRACT_PATH,
	isHiddenPath,
	isNotePath,
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
