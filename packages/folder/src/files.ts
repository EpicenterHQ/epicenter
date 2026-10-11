/** Ordinary file methods over the folder's accounted storage. */
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type Autosave,
	type AutosaveError,
	createAutosave,
	type SaveState,
} from './autosave.js';
import type {
	FileListing,
	FileWriteIntent,
	FolderStorage,
} from './boundary.js';
import {
	type CapturedFile,
	type FileCapture,
	fileCapture,
	hashBytes,
	ownBytes,
	ownCapture,
} from './capture.js';
import type { FolderDefinition } from './definition.js';
import type { FileError, MoveError, TableReadError } from './errors.js';
import { mergeSave, type SaveMerge } from './save-merge.js';
import { applyOne, replaceCaptured } from './storage.js';

/**
 * Ordinary files at literal folder-relative paths (ADR-0479).
 *
 * The verb states the condition a save publishes under. Strings are saved as
 * UTF-8 with nothing added or normalized; byte arrays are copied when the
 * method is called and saved exactly. A successful save returns a new
 * capture of the bytes it was given: nothing is read back, and the capture
 * that was passed in never changes.
 */
export type FolderFiles = {
	list(): Promise<Result<FileListing, FileError>>;
	children(
		directory: string,
	): Promise<Result<{ files: string[]; directories: string[] }, FileError>>;
	/** The file's bytes, detached from storage, with the capture that identifies them. */
	read(path: string): Promise<Result<CapturedFile, FileError>>;
	/** Stable bytes for consumption (ADR-0466). */
	open(path: string): Promise<Result<Blob, FileError>>;
	/** Save a new file. Refused when anything is already at the path. */
	create(
		path: string,
		content: string | Uint8Array,
	): Promise<Result<FileCapture, FileError>>;
	/** Save over the captured file. Refused when its bytes are no longer the captured ones. */
	replace(
		file: FileCapture,
		content: string | Uint8Array,
	): Promise<Result<FileCapture, FileError>>;
	/** Remove the captured file. Refused when its bytes are no longer the captured ones. */
	remove(file: FileCapture): Promise<Result<undefined, FileError>>;
	/**
	 * Move the captured file to an unoccupied path. The returned capture is the
	 * guarded hash at the destination: a receipt of the move, conditioned on
	 * the captured bytes, never a read of what the destination holds now. A move that landed the destination
	 * but could not remove the source reports `MoveError.SourceNotRemoved`;
	 * both paths then hold the bytes.
	 */
	move(
		file: FileCapture,
		destination: string,
	): Promise<Result<FileCapture, FileError | MoveError>>;
	/** Save at the path whatever is there, as a shell redirection does. */
	overwrite(
		path: string,
		content: string | Uint8Array,
	): Promise<Result<FileCapture, FileError>>;
	/**
	 * Save one editing session's content over the captured file. Each save is
	 * guarded by the bytes the previous one confirmed, starting from the
	 * capture, so a change made elsewhere is `Conflict` rather than
	 * overwritten; the session then needs a fresh capture. `saved` carries the
	 * capture of the bytes now in the file. Content is copied when requested.
	 * Construction reads, writes, and reports nothing.
	 */
	autosave(
		file: FileCapture,
		options: { onState(state: SaveState<FileError | AutosaveError>): void },
	): Autosave<string | Uint8Array, FileError | AutosaveError>;
	mkdir(path: string): Promise<Result<undefined, FileError>>;
	rmdir(path: string): Promise<Result<undefined, FileError>>;
	/**
	 * Merge a session's save with a change made elsewhere to the text file
	 * at `path`, by the folder's own rules as sync merges it (ADR-0514): a
	 * row by field and body, `kv.json` by key, any other text by line. `base`
	 * is what the file held when the session last saved or read it, `ours`
	 * the draft. What merges is written over the file as it is now, guarded
	 * by its bytes; what does not is held for a person (`SaveMerge`).
	 */
	merge(
		path: string,
		versions: { readonly base: string; readonly ours: string },
	): Promise<Result<SaveMerge, TableReadError>>;
};

export function createFiles({
	storage,
	definition,
}: {
	storage: FolderStorage;
	/** Which rows and settings `merge` reads by field and key. */
	definition?: FolderDefinition;
}): FolderFiles {
	/** Publish one write and return the capture of the bytes that were given. */
	async function save(
		intent: FileWriteIntent,
	): Promise<Result<FileCapture, FileError>> {
		const sha256 = await hashBytes(intent.bytes);
		const applied = await applyOne(storage, { ...intent, sha256 });
		return applied.error !== null
			? applied
			: Ok(fileCapture(intent.path, sha256));
	}

	return Object.freeze({
		list: () => storage.list(),
		children: (directory) => storage.children(directory),
		async read(path) {
			const { data: read, error: readError } = await storage.read(path);
			if (readError !== null) return Err(readError);
			return Ok(
				Object.freeze({
					...fileCapture(path, read.sha256),
					bytes: read.bytes,
				}),
			);
		},
		open: (path) => storage.open(path),
		create: (path, content) =>
			save({ kind: 'create', path, bytes: ownBytes(content) }),
		replace: (file, content) => {
			const { data: captured, error: captureError } = ownCapture(file);
			if (captureError !== null) return Promise.resolve(Err(captureError));
			// The baseline is fixed here: the capture's own hash, copied.
			const { path, sha256 } = captured;
			return save({
				kind: 'replace',
				path,
				bytes: ownBytes(content),
				expectedSha256: sha256,
			});
		},
		remove: (file) => {
			const { data: captured, error: captureError } = ownCapture(file);
			if (captureError !== null) return Promise.resolve(Err(captureError));
			const { path, sha256 } = captured;
			return applyOne(storage, {
				kind: 'remove',
				path,
				expectedSha256: sha256,
			});
		},
		move: async (file, destination) => {
			const { data: captured, error: captureError } = ownCapture(file);
			if (captureError !== null) return Err(captureError);
			const { path, sha256 } = captured;

			const applied = await applyOne(storage, {
				kind: 'move',
				from: path,
				to: destination,
				expectedSha256: sha256,
			});
			// A move carries the captured bytes, so their hash is the capture's.
			return applied.error !== null
				? applied
				: Ok(fileCapture(destination, sha256));
		},
		overwrite: (path, content) =>
			save({ kind: 'overwrite', path, bytes: ownBytes(content) }),
		merge: (path, versions) =>
			mergeSave({ storage, definition }, path, versions),
		autosave(file, { onState }) {
			const owned = ownCapture(file);
			return createAutosave({
				file: owned.data ?? file,
				prepare: (content: string | Uint8Array) =>
					owned.error !== null ? Err(owned.error) : Ok(ownBytes(content)),
				write: (bytes, over) => replaceCaptured(storage, over, bytes),
				onState,
			});
		},
		mkdir: (path) => storage.mkdir(path),
		rmdir: (path) => storage.rmdir(path),
	} satisfies FolderFiles);
}
