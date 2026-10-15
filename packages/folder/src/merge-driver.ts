/**
 * One file merged for Git's merge driver: the `epicenter merge-driver` that a
 * repository's own configuration names, so `git merge`, `git pull`, and any
 * Git client merge a data folder's files by kind (ADR-0566).
 *
 * It merges with `mergeFile`, the merge save and Sync use (ADR-0551). Git
 * hands the driver three versions as files and the path; the kind comes from
 * the nearest `epicenter.json` above the path in the working tree. The answer
 * is the merged file, a file with Git's conflict markers where both sides
 * changed one unit differently, or `git` for a file this merge leaves to
 * Git's own text merge: a path in no data folder, a declaration that does not
 * read, or a version that is not text.
 *
 * Git calls a driver only when both sides changed the path. An added file
 * on both sides reaches it with an empty base, which reads here as no base,
 * so two rows added under one name merge field by field.
 */

import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { parseDeclaration } from './declaration.js';
import { prepareFolderDefinition } from './definition.js';
import { markConflicts } from './git/merge-lines.js';
import { type FileKind, fileKindOf, mergeFile } from './merge-file.js';
import { DECLARATION_PATH } from './paths.js';

/** What the driver leaves for Git. */
export type GitMerge =
	| { readonly kind: 'merged'; readonly content: Uint8Array }
	| { readonly kind: 'conflicted'; readonly content: Uint8Array }
	/** Merge as Git would without a driver. */
	| { readonly kind: 'git'; readonly reason: string };

/** The labels the driver's conflict markers carry. */
export const CONFLICT_LABELS = { ours: 'ours', theirs: 'theirs' } as const;

const encoder = new TextEncoder();
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The kind of the repository path `path` (relative to `top`, the working
 * tree Git runs the driver in) under its nearest data folder's declaration,
 * or why Git's own merge applies.
 */
export async function gitMergeKind(
	top: string,
	path: string,
): Promise<{ kind: FileKind } | { reason: string }> {
	const segments = posix.normalize(path).split('/');
	if (segments.includes('..') || posix.isAbsolute(path))
		return { reason: `${path} is outside the working tree` };
	for (let depth = segments.length - 1; depth >= 0; depth--) {
		const folder = segments.slice(0, depth).join('/');
		const declaration = join(top, folder, DECLARATION_PATH);
		const found = await lstat(declaration).catch(() => undefined);
		if (found === undefined || !found.isFile()) continue;
		let text: string;
		try {
			text = strict.decode(await readFile(declaration));
		} catch {
			return { reason: `${declaration} is not UTF-8 text` };
		}
		const { data: declared, error } = parseDeclaration(text);
		if (error !== null)
			return { reason: `${declaration} does not read: ${error.reason}` };
		const { data: definition, error: prepareError } =
			prepareFolderDefinition(declared);
		if (prepareError !== null)
			return {
				reason: `${declaration} does not read: ${prepareError.reason}`,
			};
		return {
			kind: fileKindOf(definition, segments.slice(depth).join('/')),
		};
	}
	return { reason: `${dirname(path)} is in no data folder` };
}

/**
 * Merge three versions of one file by `kind`, for Git. A clean merge is the
 * merged file. When units compete, the file is each side's merge, with that
 * side winning every unit, marked where the two differ: a row shows the
 * fields and body lines that compete, and `kv.json` the keys. A version that
 * is not text is Git's to merge.
 */
export async function mergeForGit(
	kind: FileKind,
	versions: {
		readonly base: Uint8Array;
		readonly ours: Uint8Array;
		readonly theirs: Uint8Array;
	},
): Promise<GitMerge> {
	const merge = await mergeFile(kind, {
		base: versions.base.length === 0 ? null : versions.base,
		ours: versions.ours,
		theirs: versions.theirs,
	});
	const bytes = (content: string | Uint8Array) =>
		typeof content === 'string' ? encoder.encode(content) : content;
	if (merge.units.length === 0) {
		const { data } = merge.settle(() => {
			throw new Error('A clean merge has no unit to pick');
		});
		if (data === null || data === undefined)
			return { kind: 'git', reason: 'the merge left no file' };
		return { kind: 'merged', content: bytes(data) };
	}
	const whole = merge.units.find((unit) => unit.kind === 'whole');
	if (whole !== undefined) {
		if (whole.binary) return { kind: 'git', reason: 'a version is not text' };
		// Each side reads as its kind, but their merge does not.
		return conflicted(textOf(versions.ours), textOf(versions.theirs));
	}
	const side = (chosen: 'ours' | 'theirs') =>
		merge.settle(() => ({ kind: 'take', side: chosen })).data;
	return conflicted(side('ours'), side('theirs'));
}

const textOf = (content: Uint8Array) => strict.decode(content);

async function conflicted(
	ours: string | Uint8Array | null | undefined,
	theirs: string | Uint8Array | null | undefined,
): Promise<GitMerge> {
	if (typeof ours !== 'string' || typeof theirs !== 'string')
		return { kind: 'git', reason: 'a side of the conflict is not text' };
	if (ours === theirs) return { kind: 'merged', content: encoder.encode(ours) };
	return {
		kind: 'conflicted',
		content: encoder.encode(
			await markConflicts({ ours, theirs }, CONFLICT_LABELS),
		),
	};
}
