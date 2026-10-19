/**
 * What `@epicenter/folder` builds the browser folder handle from. Application
 * code never imports this entry (ADR-0636): an app reaches local data through
 * `openFolder` in `@epicenter/folder`, and sync integration will join there.
 */
export type { FileContent } from './merge.js';
export {
	isTableName,
	type LocalRepository,
	openRepository,
	ReadError,
	SaveError,
} from './repository.js';
export type { Issue, Row, RowChange } from './row.js';
export type { StorageChange } from './storage.js';
