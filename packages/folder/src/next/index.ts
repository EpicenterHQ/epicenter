/** The folder mirror's public types, and its pure row reader. Open through a platform entry. */
export type { OpenFolderError } from '../errors.js';
export type { ReadError } from '../shared/errors.js';
export type { WriteError } from './errors.js';
export type {
	Data,
	FileValue,
	Folder,
	Opened,
	OpenOptions,
	Patch,
	Row,
	RowIssue,
	Saved,
	Table,
	Tables,
} from './folder.js';
export { type RowReading, readRow } from './folder.js';
