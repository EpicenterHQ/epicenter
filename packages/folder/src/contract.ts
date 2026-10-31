/** The folder copy's public types, and its pure row reader. Open through a platform entry. */
export { OpenDeviceError, type OpenFolderError } from './errors.js';
export type {
	Data,
	Folder,
	FolderFile,
	Opened,
	OpenOptions,
	Patch,
	Row,
	RowIssue,
	Saved,
	Table,
	Tables,
} from './folder.js';
export {
	describeIssue,
	describeIssues,
	type RowReading,
	readRow,
} from './folder.js';
export type { ReadError } from './shared/errors.js';
export type { WriteError } from './write-refusal.js';
