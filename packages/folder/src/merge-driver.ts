/**
 * One file merged for Git's merge driver: the `epicenter merge-driver` that a
 * repository's own configuration names, so `git merge`, `git pull`, and any
 * Git client merge a data folder's files by kind (ADR-0566).
 *
 * It merges with `merge`, the merge every write and Sync use (ADR-0576). Git
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
import { type FileKind, fileKindOf, merge } from './merge-file.js';
import { DECLARATION_PATH } from './paths.js';

/** What the driver leaves for Git. */
export type GitMerge =
	| { readonly kind: 'merged'; readonly content: Uint8Array }
	| { readonly kind: 'conflicted'; readonly content: Uint8Array }
	/** Merge as Git would without a driver. */
	| { readonly kind: 'git'; readonly reason: string };

/** The labels the driver's conflict markers carry. */
const CONFLICT_LABELS = { ours: 'ours', theirs: 'theirs' } as const;

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
 * Merge three versions of one file by `kind`, for Git run by hand (ADR-0576):
 * units only one side changed merge by field or line, and two insertions at
 * one place join, with the same rules every write and Sync use. Where both
 * sides changed one unit differently, the file is each side's merge, with
 * that side winning every such unit, marked where the two differ, so Git
 * stops: in a rebase or a stash pop Git's `ours` is not the local work, and
 * no side may silently win. A version that is not text is Git's to merge.
 */
export async function mergeForGit(
	kind: FileKind,
	versions: {
		readonly base: Uint8Array;
		readonly ours: Uint8Array;
		readonly theirs: Uint8Array;
	},
): Promise<GitMerge> {
	const files = {
		base: versions.base.length === 0 ? null : versions.base,
		ours: versions.ours,
		theirs: versions.theirs,
	};
	const ours = await merge(kind, files);
	const bytes = (content: string | Uint8Array) =>
		typeof content === 'string' ? encoder.encode(content) : content;
	if (ours.overridden.length === 0) {
		if (ours.content === null)
			return { kind: 'git', reason: 'the merge left no file' };
		return { kind: 'merged', content: bytes(ours.content) };
	}
	const theirs = await merge(kind, files, { winner: 'theirs' });
	return conflicted(ours.content, theirs.content);
}

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
