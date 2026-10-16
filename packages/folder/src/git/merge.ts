/**
 * A two-parent merge of the folder's head and a fetched commit, prepared as
 * objects only. Nothing here writes files, the index, or a ref: the merge
 * runs with `noUpdateBranch` and `abortOnConflict`, and its own commit is
 * discarded.
 *
 * Root `kv.json` merges by key (`mergeKv`) when both sides changed it. The
 * merged text replaces `kv.json` in one child commit of each side, so
 * isomorphic-git's merge sees the same bytes on both sides and keeps them;
 * every other entry of those trees, modes included, is the side's own.
 * isomorphic-git merges the rest by Git's ordinary rules, and the folder's
 * commit takes that tree with the two original parents. The child commits
 * stay unreachable. A nested `kv.json` is an ordinary file.
 *
 * Sync adds its own rules (`mergePath`). Each path both sides changed
 * differently, whose versions are all plain files, is offered to it first,
 * root `kv.json` included: a version that is UTF-8 text without a NUL byte as
 * its text, any other as its bytes. Its merged content, or our file while it
 * holds the path, goes into both children the way merged `kv.json` does; a
 * held path makes the merge `conflicted`. A path it does not claim merges as
 * below. `mergeIncoming` passes no `mergePath`. A claimed path with a version
 * that is not text is never merged by content, only taken or removed, so a
 * Git `merge` attribute on it is not checked.
 *
 * isomorphic-git 1.38.5 decodes both sides of a two-sided text merge as UTF-8
 * with replacement, and its line split drops a lone carriage return, U+2028,
 * and U+2029. Such a merge is a `binary` conflict before it runs, so a merged
 * file never loses bytes either side wrote. Unchanged, identical, and
 * one-sided changes keep their exact blobs. Its merge also ignores Git's
 * `merge` attribute, so a path that attribute would merge differently is
 * refused.
 *
 * A conflict is never left in the files: the merge is `conflicted` and
 * nothing is written. Sync is how a person settles one (ADR-0514).
 */
import * as git from 'isomorphic-git';
import { mergeKv } from '../kv-merge.js';
import type { FileContent, FileVersions } from '../merge-file.js';
import { ancestors } from '../paths.js';
import { byCodePoint, isAttributesPath, mergeAttribute } from './attributes.js';
import type { MergeConflict } from './errors.js';
import {
	type Author,
	commitTree,
	type ObjectAccess,
	readBlob,
	readTreeFiles,
	type TreeFile,
	writeCommitObject,
	writeTreeFiles,
} from './objects.js';

/** The one file merged by key rather than by line. */
const ROOT_KV = 'kv.json';

const PLAIN = '100644';

/**
 * Rules for one path both sides changed: its merged content (`null` for no
 * file), `held` for a conflict the caller records, or `undefined` to leave
 * the path to Git's rules.
 */
export type MergePath = (
	path: string,
	versions: FileVersions,
) => Promise<
	| { readonly kind: 'merged'; readonly content: FileContent | null }
	| { readonly kind: 'held' }
	| undefined
>;

type PreparedMerge =
	| {
			readonly kind: 'merged';
			/** The merge commit; its parents are the head and the fetched commit. */
			readonly commit: string;
			readonly files: ReadonlyMap<string, TreeFile>;
	  }
	| {
			readonly kind: 'conflicted';
			readonly conflicts: readonly MergeConflict[];
			/** Paths `mergePath` held; empty without it. */
			readonly held: readonly string[];
	  }
	| {
			readonly kind: 'unmergeable';
			readonly paths: readonly string[];
			readonly reason: string;
	  };

/** The best common ancestors of two commits, as isomorphic-git's merge finds them. */
export function mergeBases(
	access: ObjectAccess,
	head: string,
	fetched: string,
): Promise<string[]> {
	return git.findMergeBase({ ...access, oids: [head, fetched] });
}

const same = (left: TreeFile | undefined, right: TreeFile | undefined) =>
	left === undefined || right === undefined
		? left === right
		: left.oid === right.oid && left.mode === right.mode;

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
/** isomorphic-git's own line split for a text merge. */
const LINES = /^.*(\r?\n|$)/gm;

function strictText(bytes: Uint8Array): string | undefined {
	try {
		return strict.decode(bytes);
	} catch {
		return undefined;
	}
}

/** Whether isomorphic-git's line merge reads these bytes back exactly. */
function mergesAsText(bytes: Uint8Array): boolean {
	if (bytes.includes(0)) return false;
	const text = strictText(bytes);
	return text !== undefined && (text.match(LINES) ?? []).join('') === text;
}

/**
 * A child of `commit` whose file at each path of `overrides` is that blob,
 * or absent for `null`. Every other entry, modes included, is the commit's.
 */
async function withOverrides(
	access: ObjectAccess,
	commit: string,
	overrides: ReadonlyMap<string, string | null>,
	author: Author,
): Promise<string> {
	const files = await readTreeFiles(access, await commitTree(access, commit));
	for (const [path, blob] of overrides)
		if (blob === null) files.delete(path);
		else files.set(path, { mode: PLAIN, oid: blob });
	return writeCommitObject(access, {
		tree: await writeTreeFiles(access, files),
		parents: [commit],
		message: 'Merge with prepared paths',
		author,
	});
}

/**
 * Merge `head` and `fetched` over their single merge base `base`, or over an
 * empty tree when `base` is undefined: histories that share no commit, which
 * a caller merges only when asked to allow unrelated histories. Objects
 * written on the way stay unreachable unless the caller publishes the merged
 * commit, which no ref names yet.
 */
export async function prepareMerge(
	access: ObjectAccess,
	{
		base,
		head,
		fetched,
		author,
		message,
		mergePath,
	}: {
		/** Undefined: no common commit, so every file of either side is an addition. */
		base: string | undefined;
		head: string;
		fetched: string;
		author: Author;
		message: string;
		/** Sync's rules for paths both sides changed. */
		mergePath?: MergePath;
	},
): Promise<PreparedMerge> {
	const [b, o, t] = (await Promise.all(
		[base, head, fetched].map(async (commit) =>
			commit === undefined
				? new Map<string, TreeFile>()
				: readTreeFiles(access, await commitTree(access, commit)),
		),
	)) as [Map<string, TreeFile>, Map<string, TreeFile>, Map<string, TreeFile>];
	const bytes = (entry: TreeFile) => readBlob(access, entry.oid);
	const conflicts: MergeConflict[] = [];

	// Paths sync's rules claimed: what both sides' children hold there, the
	// merged bytes or, while held, our file; `null` for no file. A path whose
	// versions are all text is merged as text, so a `merge` attribute on it
	// is refused below.
	const claimed = new Map<string, Uint8Array | null>();
	const claimedText: string[] = [];
	const held: string[] = [];
	if (mergePath !== undefined)
		for (const path of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
			const sides = [b.get(path), o.get(path), t.get(path)] as const;
			const [eb, eo, et] = sides;
			if (same(eo, et) || same(eo, eb) || same(et, eb)) continue;
			if (sides.some((entry) => entry !== undefined && entry.mode !== PLAIN))
				continue;
			const contents: (FileContent | null)[] = [];
			for (const entry of sides) {
				if (entry === undefined) {
					contents.push(null);
					continue;
				}
				const read = await bytes(entry);
				const text = read.includes(0) ? undefined : strictText(read);
				contents.push(text ?? read);
			}
			const [base, ours, theirs] = contents as [
				FileContent | null,
				FileContent | null,
				FileContent | null,
			];
			const merged = await mergePath(path, { base, ours, theirs });
			if (merged === undefined) continue;
			if (contents.every((content) => !(content instanceof Uint8Array)))
				claimedText.push(path);
			if (merged.kind === 'merged')
				claimed.set(
					path,
					typeof merged.content === 'string'
						? encoder.encode(merged.content)
						: merged.content,
				);
			else {
				held.push(path);
				claimed.set(path, eo === undefined ? null : await bytes(eo));
			}
		}

	// Root kv.json, when both sides changed it differently. `kv` is what both
	// sides' children hold: the merged bytes, `null` for no file, or
	// `undefined` to leave each side's own file to the ordinary merge.
	let kv: Uint8Array | null | undefined;
	const [kb, ko, kt] = [b, o, t].map((files) => files.get(ROOT_KV));
	if (
		!claimed.has(ROOT_KV) &&
		!same(ko, kt) &&
		!same(ko, kb) &&
		!same(kt, kb)
	) {
		const plain =
			[kb, ko, kt].every(
				(entry) => entry === undefined || entry.mode === PLAIN,
			) &&
			[b, o, t].every((files) =>
				[...files.keys()].every((path) => !path.startsWith(`${ROOT_KV}/`)),
			);
		if (!plain)
			return {
				kind: 'unmergeable',
				paths: [ROOT_KV],
				reason: 'kv.json is not a plain file on every side',
			};
		const sources = { base: kb, ours: ko, theirs: kt };
		const texts: Record<keyof typeof sources, string | null> = {
			base: null,
			ours: null,
			theirs: null,
		};
		let invalid: keyof typeof sources | undefined;
		for (const side of ['base', 'ours', 'theirs'] as const) {
			const entry = sources[side];
			if (entry === undefined) continue;
			const text = strictText(await bytes(entry));
			if (text === undefined) {
				invalid ??= side;
				continue;
			}
			texts[side] = text;
		}
		const merged =
			invalid === undefined
				? mergeKv(texts)
				: ({ kind: 'invalid', side: invalid } as const);
		switch (merged.kind) {
			case 'merged':
				kv = merged.text === null ? null : encoder.encode(merged.text);
				break;
			case 'conflict':
				for (const conflict of merged.conflicts)
					conflicts.push({ reason: 'kvKey', path: ROOT_KV, ...conflict });
				break;
			case 'file-conflict':
				conflicts.push({ reason: 'kvFile', path: ROOT_KV });
				break;
			case 'invalid':
				conflicts.push({
					reason: 'kvInvalid',
					path: ROOT_KV,
					side: merged.side,
				});
				break;
		}
		// A conflicted kv.json gives both sides our file, so the rest still
		// merges and reports its own conflicts. Nothing is published.
		if (kv === undefined) kv = ko === undefined ? null : await bytes(ko);
	}

	// Every other path by Git's rules. `present` is where a file will be, so a
	// file on one side under a directory on the other is found before the
	// merge, which isomorphic-git does not support.
	const present = new Set<string>();
	const textMerges: string[] = [];
	for (const path of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
		if (path === ROOT_KV && kv !== undefined) {
			if (kv !== null) present.add(path);
			continue;
		}
		if (claimed.has(path)) {
			if (claimed.get(path) !== null) present.add(path);
			continue;
		}
		const [eb, eo, et] = [b.get(path), o.get(path), t.get(path)];
		if (same(eo, et) || same(eo, eb)) {
			if (et !== undefined) present.add(path);
			continue;
		}
		if (same(et, eb)) {
			if (eo !== undefined) present.add(path);
			continue;
		}
		present.add(path);
		if (eo === undefined || et === undefined) {
			conflicts.push({
				reason: 'deleted',
				path,
				deletedBy: eo === undefined ? 'ours' : 'theirs',
			});
			continue;
		}
		textMerges.push(path);
	}

	const special = textMerges.filter((path) =>
		[b.get(path), o.get(path), t.get(path)].some(
			(entry) => entry !== undefined && entry.mode !== PLAIN,
		),
	);
	if (special.length > 0)
		return {
			kind: 'unmergeable',
			paths: special,
			reason:
				'both sides changed a file that is a symbolic link, executable, or submodule in one of its versions',
		};
	const asText: string[] = [];
	for (const path of textMerges) {
		let text = true;
		for (const entry of [b.get(path), o.get(path), t.get(path)])
			if (entry !== undefined && !mergesAsText(await bytes(entry))) {
				text = false;
				break;
			}
		if (text) asText.push(path);
		else conflicts.push({ reason: 'binary', path });
	}
	// A path sync merged by its own rules as text is merged as text too, so a
	// `merge` attribute on it is refused the same way.
	const textual = [...asText, ...claimedText];
	if (textual.length > 0)
		for (const files of [b, o, t]) {
			const attributeFiles = new Map<string, Uint8Array>();
			for (const [path, entry] of files)
				if (isAttributesPath(path))
					attributeFiles.set(path, await bytes(entry));
			const declared = mergeAttribute(attributeFiles, textual);
			if (declared !== undefined)
				return {
					kind: 'unmergeable',
					paths: [declared.path],
					reason: `the Git attribute ${declared.attribute} applies to ${declared.path}, and this folder merges text only by Git's default rule`,
				};
		}

	const shapes = new Set<string>();
	for (const path of present)
		for (const parent of ancestors(path))
			if (present.has(parent)) shapes.add(parent);
	for (const path of shapes) conflicts.push({ reason: 'shape', path });

	const signature = { name: author.name, email: author.email };
	/** isomorphic-git's merge of the two sides, each with `overrides` applied. */
	async function mergeWith(overrides: ReadonlyMap<string, string | null>) {
		let [ours, theirs] = [head, fetched];
		if (overrides.size > 0)
			[ours, theirs] = (await Promise.all(
				[head, fetched].map((side) =>
					withOverrides(access, side, overrides, author),
				),
			)) as [string, string];
		return (
			await git.merge({
				...access,
				ours,
				theirs,
				fastForward: false,
				noUpdateBranch: true,
				abortOnConflict: true,
				// Its own base is then the empty tree, the same as `b` here.
				allowUnrelatedHistories: base === undefined,
				message,
				author: signature,
				committer: signature,
			})
		).tree;
	}
	const unsupported = {
		kind: 'unmergeable',
		paths: [],
		reason:
			'isomorphic-git does not merge this combination of files and directories',
	} as const;

	let tree: string | undefined;
	const overrides = new Map<string, string | null>();
	if (shapes.size === 0) {
		if (kv !== undefined)
			overrides.set(
				ROOT_KV,
				kv === null ? null : await git.writeBlob({ ...access, blob: kv }),
			);
		for (const [path, blob] of claimed)
			overrides.set(
				path,
				blob === null ? null : await git.writeBlob({ ...access, blob }),
			);
		try {
			tree = await mergeWith(overrides);
		} catch (cause) {
			if (cause instanceof git.Errors.MergeNotSupportedError)
				return unsupported;
			if (!(cause instanceof git.Errors.MergeConflictError)) throw cause;
			const reported = new Set(conflicts.map((conflict) => conflict.path));
			for (const path of cause.data.bothModified)
				if (!reported.has(path)) conflicts.push({ reason: 'content', path });
		}
	}
	conflicts.sort((left, right) => byCodePoint(left.path, right.path));

	if (conflicts.length > 0 || held.length > 0)
		return { kind: 'conflicted', conflicts, held: held.sort(byCodePoint) };
	if (tree === undefined) throw new Error('The merge produced no tree');

	const files = await readTreeFiles(access, tree);
	for (const [path, blob] of overrides)
		if ((files.get(path)?.oid ?? null) !== blob)
			throw new Error(`The merged tree does not hold the merged ${path}`);
	const commit = await writeCommitObject(access, {
		tree,
		parents: [head, fetched],
		message,
		author,
	});
	return { kind: 'merged', commit, files };
}
