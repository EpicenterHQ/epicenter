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
import type { FileError } from './errors.js';
import { SyncError } from './git/errors.js';
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
	{
		restore = true,
	}: {
		/** False when a file deleted elsewhere must stay deleted. */
		readonly restore?: boolean;
	} = {},
): Promise<Result<SaveMerge, FileError>> {
	const read = await storage.read(path);
	if (read.error !== null && read.error.name !== 'NotFound')
		return Err(read.error);
	let over: FileCapture | undefined;
	let theirs: string | null = null;
	if (read.error === null) {
		over = fileCapture(path, read.data.sha256);
		try {
			theirs = utf8.decode(read.data.bytes);
		} catch {
			return Ok(heldBytes(storage, over, versions, read.data.bytes));
		}
	}
	const merged = await mergeFile(definition, path, { ...versions, theirs });
	/**
	 * `text`, or their exact bytes when `text` is only their version in the
	 * standard form: a row merged with itself is written that way.
	 */
	const theirsWhenSame = async (text: string | null) => {
		if (text === null || theirs === null) return text;
		const same = await mergeFile(definition, path, {
			base: theirs,
			ours: theirs,
			theirs,
		});
		return same.kind === 'merged' && same.text === text ? theirs : text;
	};
	if (merged.kind === 'merged') {
		const { data: file, error } = await publish(
			storage,
			path,
			over,
			await theirsWhenSame(merged.text),
		);
		if (error !== null) return Err(error);
		return Ok({ kind: 'saved', file });
	}
	const file = merged.conflicts.find(({ kind }) => kind === 'file');
	return Ok(
		Object.freeze({
			kind: 'held',
			conflicts: merged.conflicts,
			async resolve(choices: unknown) {
				const { data: text, error } = merged.settle(choices);
				if (error !== null) return Err(error);
				if (!restore && over === undefined && text !== null)
					return SyncError.InvalidChoices({
						problems: [
							{
								conflictId: file?.id,
								reason: 'disallowed',
								message:
									'This file was deleted elsewhere and cannot be restored here',
							},
						],
					});
				return publish(storage, path, over, await theirsWhenSame(text));
			},
		}),
	);
}

/**
 * A file that is no longer text, against the draft: one whole-file unit.
 * Their bytes can be kept or the file replaced, never edited as text.
 */
function heldBytes(
	storage: Pick<FolderStorage, 'apply'>,
	over: FileCapture,
	versions: { readonly base: string; readonly ours: string },
	bytes: Uint8Array,
): SaveMerge {
	const conflict: SyncConflict = Object.freeze({
		id: JSON.stringify(['file', over.path]),
		kind: 'file',
		path: over.path,
		base: Object.freeze({ present: true, value: versions.base }),
		local: Object.freeze({ present: true, value: versions.ours }),
		incoming: Object.freeze({ present: true, value: bytes.slice() }),
	});
	return Object.freeze({
		kind: 'held',
		conflicts: Object.freeze([conflict]),
		async resolve(choices: unknown) {
			const choice =
				typeof choices === 'object' &&
				choices !== null &&
				Object.hasOwn(choices, conflict.id)
					? (choices as Record<string, unknown>)[conflict.id]
					: undefined;
			const { kind, side, value } = (choice ?? {}) as {
				kind?: unknown;
				side?: unknown;
				value?: unknown;
			};
			if (kind === 'take' && side === 'incoming') return Ok(over);
			if (kind === 'take' && side === 'local')
				return publish(storage, over.path, over, versions.ours);
			if (kind === 'replace' && typeof value === 'string')
				return publish(storage, over.path, over, value);
			if (kind === 'remove') return publish(storage, over.path, over, null);
			return SyncError.InvalidChoices({
				problems: [
					{
						conflictId: conflict.id,
						reason: choice === undefined ? 'missing' : 'malformed',
						message:
							'Keep their file, use yours, replace it with text, or remove it',
					},
				],
			});
		},
	});
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
