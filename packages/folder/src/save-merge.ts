/**
 * A save that met a change made elsewhere, merged the way sync merges a
 * file (ADR-0514) and published over that change, guarded by its bytes.
 *
 * The caller names the file and the two versions it holds: `base`, what the
 * file held when its session last saved or read it, and `ours`, the draft.
 * The file as it is now is `theirs`. What merges is written at once; what
 * does not is held for a person, and `resolve(choices)` writes their answer.
 * Every write is guarded by the bytes read here, so a further change made
 * elsewhere is `Conflict` and nothing is overwritten.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import { type FileCapture, fileCapture, hashBytes } from './capture.js';
import type { FolderDefinition } from './definition.js';
import { type FileError, TableError, type TableReadError } from './errors.js';
import type { SyncError } from './git/errors.js';
import { mergeFile, type SyncConflict } from './git/sync.js';
import { applyOne } from './storage.js';

/**
 * - `saved`: everything merged and was written; `file` is the capture of
 *   what the file holds now, `undefined` when the result is no file.
 * - `held`: units both changed differently. `resolve` settles one choice for
 *   each, as sync does, and writes the result over the version read here.
 */
export type SaveMerge =
	| { readonly kind: 'saved'; readonly file: FileCapture | undefined }
	| {
			readonly kind: 'held';
			readonly conflicts: readonly SyncConflict[];
			resolve(
				choices: unknown,
			): Promise<Result<FileCapture | undefined, SyncError | FileError>>;
	  };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export async function mergeSave(
	{
		storage,
		definition,
	}: {
		storage: Pick<FolderStorage, 'apply' | 'read'>;
		definition: FolderDefinition | undefined;
	},
	path: string,
	versions: { readonly base: string; readonly ours: string },
): Promise<Result<SaveMerge, TableReadError>> {
	const read = await storage.read(path);
	if (read.error !== null && read.error.name !== 'NotFound')
		return Err(read.error);
	let theirs: { file: FileCapture; text: string } | undefined;
	if (read.error === null) {
		const file = fileCapture(path, read.data.sha256);
		try {
			theirs = { file, text: utf8.decode(read.data.bytes) };
		} catch {
			return TableError.InvalidUtf8(file);
		}
	}
	const over = theirs?.file;
	const merged = await mergeFile(definition, path, {
		...versions,
		theirs: theirs?.text ?? null,
	});
	if (merged.kind === 'merged') {
		const { data: file, error } = await publish(
			storage,
			path,
			over,
			merged.text,
		);
		if (error !== null) return Err(error);
		return Ok({ kind: 'saved', file });
	}
	return Ok(
		Object.freeze({
			kind: 'held',
			conflicts: merged.conflicts,
			async resolve(choices: unknown) {
				const { data: text, error } = merged.settle(choices);
				if (error !== null) return Err(error);
				return publish(storage, path, over, text);
			},
		}),
	);
}

/**
 * Leave `text` at `path` over the version captured as `over`: replace it,
 * create the file when there was none, or remove it for `null`. Nothing is
 * written when the file already holds that result.
 */
async function publish(
	storage: Pick<FolderStorage, 'apply'>,
	path: string,
	over: FileCapture | undefined,
	text: string | null,
): Promise<Result<FileCapture | undefined, FileError>> {
	if (text === null) {
		if (over === undefined) return Ok(undefined);
		const removed = await applyOne(storage, {
			kind: 'remove',
			path,
			expectedSha256: over.sha256,
		});
		return removed.error === null ? Ok(undefined) : removed;
	}
	const bytes = encoder.encode(text);
	const sha256 = await hashBytes(bytes);
	if (over?.sha256 === sha256) return Ok(over);
	const applied = await applyOne(
		storage,
		over === undefined
			? { kind: 'create', path, bytes, sha256 }
			: { kind: 'replace', path, bytes, sha256, expectedSha256: over.sha256 },
	);
	return applied.error === null ? Ok(fileCapture(path, sha256)) : applied;
}
