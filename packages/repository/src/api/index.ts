/**
 * The repository API a page uses: an app's collections declared once
 * (`defineApp`), and one repository handle over a host. The browser host
 * is `@epicenter/repository/api/browser`; the in-process host, for Bun and
 * tests, is here.
 */
export { type App, defineApp, type NoteDefinition, type NoteName, timestamp } from '../core/lens.js';
export { type Collection, type Delta, type Row, SaveError, type Snapshot } from '../client/page.js';
export { type Change, type Changed, ChangeError, type FileStatus } from '../client/replica.js';
export { collectionsOf, createLocalHost, openLocalRepository } from './local.js';
export { type Editor, type EditorChange, EditorError, type EditorOptions, type EditorState } from './editor.js';
export { applyChanges, diffText, rebase, type TextChange } from '../core/diff.js';
export { type Definitions, type TextStatus } from '../core/lens.js';
export {
	type FieldPatch,
	type Host,
	type HostState,
	type MemoryCollection,
	type Note,
	type NoteInput,
	openRepository,
	type Repository,
	type RepositoryChange,
	RepositoryError,
	type RepositoryStatus,
	type Session,
	type StoredCollection,
	type Writes,
	type WriteError,
	type Written,
} from './repository.js';
