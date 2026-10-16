/**
 * Sync's one merge commit, computed as objects only (ADR-0576). Nothing here
 * writes a file, the index, or a ref.
 *
 * Each path that changed between the base and either head is settled once,
 * net. A path only one side changed, or both changed alike, keeps that
 * side's blob and mode exactly. A path both changed differently takes
 * `merge(kind, { base, ours, theirs })`, `ours` the device syncing. A delete
 * beats an edit it never saw. A rename is a path one side deleted and the
 * same side created elsewhere with the deleted path's blob at the base, the
 * only such pair: the other side's version, and the base's, move to the new
 * path first, so its edit merges there. A file against a directory at one
 * path keeps the directory, and the file beside it as `<path>~<side>`,
 * or `<path>~<side>-2` and on when that name is taken.
 *
 * A path the folder keeps local is in no merge commit (ADR-0577).
 */
import * as git from 'isomorphic-git';
import {
	type FileKind,
	merge,
	type Overridden,
	wholeFile,
} from '../merge-file.js';
import {
	commitTree,
	EMPTY_TREE,
	type ObjectAccess,
	readBlob,
	readTreeFiles,
	type TreeFile,
	writeTreeFiles,
} from './objects.js';

const PLAIN = '100644';

/** One unit a merge commit's side lost, and the commit that held it. */
export type Override = {
	readonly path: string;
	readonly unit: Overridden;
	/** The parent whose version lost: the local head or the remote's. */
	readonly losing: string;
};

/** The tree of Sync's merge commit, and every unit a side lost in it. */
type HistoryMerge = {
	readonly tree: string;
	readonly overrides: readonly Override[];
};

const same = (left: TreeFile | undefined, right: TreeFile | undefined) =>
	left === undefined || right === undefined
		? left === right
		: left.oid === right.oid && left.mode === right.mode;

/**
 * The merge base of `ours` and `theirs`: the one best common ancestor, or,
 * where merges run by hand left several, the one with the newest committer
 * time and, on a tie, the smallest object ID, so every host picks the same.
 * `undefined` when the histories share no commit.
 */
export async function chooseBase(
	access: ObjectAccess,
	ours: string,
	theirs: string,
): Promise<string | undefined> {
	const bases = await git.findMergeBase({ ...access, oids: [ours, theirs] });
	if (bases.length <= 1) return bases[0];
	const timed = await Promise.all(
		bases.map(async (oid) => ({
			oid,
			time: (await git.readCommit({ ...access, oid })).commit.committer
				.timestamp,
		})),
	);
	timed.sort((left, right) =>
		right.time !== left.time
			? right.time - left.time
			: left.oid < right.oid
				? -1
				: left.oid > right.oid
					? 1
					: 0,
	);
	return timed[0]!.oid;
}

/** The files of `commit`, or none for no commit. */
async function filesOf(access: ObjectAccess, commit: string | undefined) {
	if (commit === undefined) return new Map<string, TreeFile>();
	const tree = await commitTree(access, commit);
	return tree === EMPTY_TREE
		? new Map<string, TreeFile>()
		: readTreeFiles(access, tree);
}

/**
 * Move one side's renames onto their new paths in the other side and the
 * base: a path `side` deleted and created elsewhere holding the deleted
 * path's blob at the base, where neither path is ambiguous and nothing else
 * stands at the new path.
 */
function followRenames(
	base: Map<string, TreeFile>,
	side: ReadonlyMap<string, TreeFile>,
	other: Map<string, TreeFile>,
) {
	const deleted = [...base].filter(([path]) => !side.has(path));
	const created = [...side].filter(([path]) => !base.has(path));
	const count = (entries: [string, TreeFile][], oid: string) =>
		entries.filter(([, entry]) => entry.oid === oid).length;
	for (const [from, entry] of deleted) {
		if (count(deleted, entry.oid) !== 1) continue;
		const matches = created.filter(([, made]) => made.oid === entry.oid);
		if (matches.length !== 1) continue;
		const to = matches[0]![0];
		if (other.has(to) || !other.has(from)) continue;
		other.set(to, other.get(from)!);
		other.delete(from);
		base.set(to, entry);
		base.delete(from);
	}
}

/**
 * Merge `ours` and `theirs` over `base` into a tree, with `ours` the writer
 * acting. `kindOf` says how each path merges; `isLocal` names the paths
 * kept out of every commit.
 */
export async function mergeHistories(
	access: ObjectAccess,
	{
		base,
		ours,
		theirs,
		kindOf,
		isLocal,
	}: {
		readonly base: string | undefined;
		readonly ours: string;
		readonly theirs: string;
		readonly kindOf: (path: string) => FileKind;
		readonly isLocal: (path: string) => boolean;
	},
): Promise<HistoryMerge> {
	const kept = (files: Map<string, TreeFile>) =>
		new Map([...files].filter(([path]) => !isLocal(path)));
	const b = kept(await filesOf(access, base));
	const o = kept(await filesOf(access, ours));
	const t = kept(await filesOf(access, theirs));
	followRenames(b, o, t);
	followRenames(b, t, o);
	const result = new Map<string, TreeFile>();
	const overrides: Override[] = [];
	const read = (entry: TreeFile | undefined) =>
		entry === undefined ? null : readBlob(access, entry.oid);
	for (const path of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
		const [atBase, mine, yours] = [b.get(path), o.get(path), t.get(path)];
		let settled: TreeFile | undefined;
		if (same(mine, yours) || same(yours, atBase)) settled = mine;
		else if (same(mine, atBase)) settled = yours;
		else {
			const versions = {
				base: await read(atBase),
				ours: await read(mine),
				theirs: await read(yours),
			};
			const plain = [atBase, mine, yours].every(
				(entry) => entry === undefined || entry.mode === PLAIN,
			);
			const merged = !plain
				? wholeFile(versions)
				: await merge(kindOf(path), versions);
			for (const unit of merged.overridden)
				overrides.push({
					path,
					unit,
					losing: unit.kind === 'file' && unit.lost === 'ours' ? ours : theirs,
				});
			if (merged.content === null) settled = undefined;
			else if (merged.content === versions.ours && mine !== undefined)
				settled = mine;
			else if (merged.content === versions.theirs && yours !== undefined)
				settled = yours;
			else
				settled = {
					mode: PLAIN,
					oid: await git.writeBlob({
						...access,
						blob:
							typeof merged.content === 'string'
								? new TextEncoder().encode(merged.content)
								: merged.content,
					}),
				};
		}
		if (settled !== undefined) result.set(path, settled);
	}
	// A file where the other side made a directory stands beside it, under
	// the first name nothing else takes.
	const taken = (name: string) =>
		result.has(name) ||
		[...result.keys()].some((other) => other.startsWith(`${name}/`));
	for (const path of [...result.keys()]) {
		if (![...result.keys()].some((other) => other.startsWith(`${path}/`)))
			continue;
		const entry = result.get(path)!;
		result.delete(path);
		const beside = `${path}~${same(entry, o.get(path)) ? 'local' : 'remote'}`;
		let name = beside;
		for (let next = 2; taken(name); next++) name = `${beside}-${next}`;
		result.set(name, entry);
	}
	return { tree: await writeTreeFiles(access, result), overrides };
}

/** One unit as a trailer names it: fixed fields first, quoted values. */
function unitWords(unit: Overridden): string {
	switch (unit.kind) {
		case 'field':
			return `field=${JSON.stringify(unit.field)}`;
		case 'setting':
			return `setting=${JSON.stringify(unit.key)}`;
		case 'lines':
			return `lines=${unit.part}:${unit.line}+${unit.count}`;
		case 'file':
			return 'file';
	}
}

/**
 * A merge commit's message: its subject, then one `Overrode:` trailer per
 * unit that lost, the losing commit first and the path last, quoted, since
 * a path may hold spaces.
 */
export function mergeMessage(
	subject: string,
	overrides: readonly Override[],
): string {
	if (overrides.length === 0) return subject;
	const lines = overrides.map(
		({ path, unit, losing }) =>
			`Overrode: ${losing} ${unitWords(unit)} ${JSON.stringify(path)}`,
	);
	return `${subject}\n\n${lines.join('\n')}`;
}
