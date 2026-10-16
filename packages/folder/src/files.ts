/** Ordinary file methods over the folder's accounted storage. */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileListing, FolderStorage } from './boundary.js';
import {
	type CapturedFile,
	type ContentCapture,
	type FileCapture,
	fileCapture,
	ownBytes,
	ownCapture,
} from './capture.js';
import type { FolderDefinition } from './definition.js';
import type { FileError, FileSaveError, MoveError } from './errors.js';
import { fileKindOf } from './merge-file.js';
import { type SavedFile, type SaveOptions, saveFile } from './save-file.js';
import { createFile, moveFile, openFile, removeFile } from './storage.js';

/**
 * Ordinary files at literal folder-relative paths (ADR-0479).
 *
 * The verb states the condition a write publishes under. Strings are saved
 * as UTF-8 with nothing added or normalized; byte arrays are copied when the
 * method is called and saved exactly. A read, a create, and a save return a
 * capture that carries its bytes, the base the next save merges from
 * (ADR-0551). Nothing is read back, and the capture that was passed in never
 * changes.
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
	): Promise<Result<CapturedFile, FileError>>;
	/**
	 * Save an edit of the file `base` captured (ADR-0551). When the file
	 * still holds the captured bytes, `content` is written over them.
	 * Otherwise another writer changed it, and the edit is merged with their
	 * file by its kind (a row by field and body line, other text by line),
	 * the edit winning only where both changed the same unit;
	 * `replaced` names what of theirs that replaced. With `{ merge: false }`
	 * a moved file is `Conflict` instead.
	 *
	 * `base` must carry the content it names, as every capture the folder
	 * returns does; otherwise the save is `UnknownBase`. A deleted file is
	 * `NotFound`: a save never recreates one.
	 */
	save(
		base: ContentCapture,
		content: string | Uint8Array,
		options?: SaveOptions,
	): Promise<Result<SavedFile, FileSaveError>>;
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
	mkdir(path: string): Promise<Result<undefined, FileError>>;
	rmdir(path: string): Promise<Result<undefined, FileError>>;
};

/**
 * The file methods over `storage`. `definition` decides how a save merges
 * each path (`fileKindOf`); without one, every path merges as a plain file.
 */
export function createFiles({
	storage,
	definition,
}: {
	storage: FolderStorage;
	definition?: FolderDefinition;
}): FolderFiles {
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
		open: (path) => openFile(storage, path),
		async create(path, content) {
			const bytes = ownBytes(content);
			const created = await createFile(storage, path, bytes);
			if (created.error !== null) return created;
			return Ok(Object.freeze({ ...created.data, bytes }));
		},
		async save(base, content, options) {
			const path = (base as Partial<FileCapture> | null | undefined)?.path;
			const { data: written, error } = await saveFile(
				storage,
				fileKindOf(definition, typeof path === 'string' ? path : ''),
				base,
				ownBytes(content),
				options,
			);
			if (error !== null) return Err(error);
			return Ok(
				Object.freeze({
					stored: Object.freeze({
						...fileCapture(written.path, written.sha256),
						bytes: written.bytes,
					}),
					merged: written.merged,
				}),
			);
		},
		remove: (file) => {
			const { data: captured, error: captureError } = ownCapture(file);
			if (captureError !== null) return Promise.resolve(Err(captureError));
			return removeFile(storage, captured);
		},
		move: async (file, destination) => {
			const { data: captured, error: captureError } = ownCapture(file);
			if (captureError !== null) return Err(captureError);
			return moveFile(storage, captured, destination);
		},
		mkdir: (path) => storage.mkdir(path),
		rmdir: (path) => storage.rmdir(path),
	} satisfies FolderFiles);
}
