/**
 * The repository API an app uses: its collections declared once
 * (`defineApp`), one repository handle over them, the editor of a note and
 * what a body view of it needs. The browser host is
 * `@epicenter/repository/browser`; `openLocalRepository` opens one
 * over a replica in this process (Bun, a script).
 */
export { type App, type BlobDefinition, type BlobName, combineApps, type Definitions, defineApp, type NoteDefinition, type NoteName, type TextStatus, timestamp } from '../core/lens.js';
export { SaveError } from '../client/page.js';
export { BlobError } from '../client/bytes.js';
export { TemplateError } from '../core/templates.js';
export { BlobStoreError } from '../client/blobs.js';
export { extensionOf, mediaType } from '../core/media.js';
export { ChangeError, type FileStatus, type Outcome } from '../client/replica.js';
export { openLocalRepository } from './local.js';
export { type Editor, type EditorChange, EditorError, type EditorState, type Unsaved } from './editor.js';
export { bodyChanges, type TextChange } from '../core/diff.js';
export { bodyOf, withBody } from '../core/markdown.js';
export {
	type BatchFiles,
	type BlobCollection,
	type BlobWriteError,
	type BlobWritten,
	type Committed,
	type FieldPatch,
	type FileEntry,
	type Files,
	type FileWriteError,
	type FileText,
	type InvalidNote,
	type MemoryCollection,
	type Note,
	type NoteInput,
	type OpenBlobError,
	type Repository,
	type RepositoryChange,
	RepositoryError,
	type RepositoryStatus,
	type StoredCollection,
	type ValidNote,
	type WriteError,
	type Written,
} from './repository.js';
