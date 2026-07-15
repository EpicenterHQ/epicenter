/**
 * Node and Bun-only workspace primitives.
 *
 * Keep these exports out of the browser-safe root barrel because they use
 * filesystem and SQLite APIs. Application-specific runtimes compose them
 * directly; this entrypoint owns no process or mount lifecycle.
 */

export {
	attachYjsLog,
	type YjsLogAttachment,
} from './document/attach-yjs-log.js';
export {
	attachYjsLogReader,
	type YjsLogReaderAttachment,
} from './document/attach-yjs-log-reader.js';
export {
	type BunLocalPersistenceOptions,
	bunLocalPersistence,
} from './document/bun-local-persistence.js';
export {
	type OpenSqliteReaderOptions,
	openSqliteReader,
	type SqliteReader,
} from './document/open-sqlite-reader.js';
