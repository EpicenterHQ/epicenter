/**
 * The folder contract: everything an application names besides the opener.
 *
 * `@epicenter/folder`, `/browser`, `/tauri`, and `/bun` all export this
 * module unchanged, so code written against one entry type-checks against the
 * others, and an explicit entry never pulls the automatic selector into its
 * graph.
 *
 * This module is inert. Importing it opens nothing and loads no storage and
 * no runtime-specific module.
 */
export { OpenFolderError } from './errors.js';
export type {
	DefaultFolderOptions,
	DirectoryFolderOptions,
	FileContent,
	Folder,
	FolderChange,
	FolderFiles,
	FolderStatus,
	FolderTable,
	FolderTables,
	Issue,
	OpenFolder,
	Row,
	RowChange,
} from './folder.js';
export { ReadError, SaveError } from './shared/errors.js';
