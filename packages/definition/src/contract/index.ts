/**
 * `@epicenter/definition/contract`: an app's file layout as plain data, the
 * typed client it derives, the path functions every opener shares, and the
 * check `epicenter check` runs.
 */
export {
	type Client,
	ClientError,
	type CollectionClient,
	type FieldsOf,
	type FileClient,
	type FileEntryOf,
	type FileOf,
	type NoteClient,
	type NoteOf,
	type Over,
	type PlaceholdersOf,
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
export {
	compileTemplate,
	fill,
	isFilePath,
	isNotePath,
	isNoteTemplate,
	match,
	type Params,
	type Segment,
	type Template,
	TemplateError,
	templatesOverlap,
} from './templates.js';
