/**
 * Sync's one merge commit, computed as objects only (ADR-0576). Nothing here
 * writes a file, the index, or a ref.
 *
 * The tree uses the shared `mergeTrees` in `git/tree-merge.ts`, so one
 * policy settles every host's Sync: the base is the common tree, `current`
 * the remote's, and `change` this device's. A path only one side changed, or
 * both changed alike, keeps that side's entry exactly. A file both changed
 * differently takes the shared content merge (`shared/merge.ts`), where the
 * change wins each unit both changed. A delete never erases an edit it did
 * not see, and a file against a directory at one path takes this device's
 * entry whole. No rename is followed: a path one side moved and the other
 * edited keeps both, the edit at the old path. A side that lost a whole
 * entry keeps it in its parent commit, which the merge message names.
 */
import * as git from 'isomorphic-git';
import type { Overridden } from '../shared/merge.js';
import { commitTree, EMPTY_TREE, type ObjectAccess } from './objects.js';
import type { GitObject } from './raw-objects.js';
import { mergeTrees, overrodeTrailer } from './tree-merge.js';

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
	const timed = [];
	for (const oid of bases)
		timed.push({
			oid,
			time: (await git.readCommit({ ...access, oid })).commit.committer
				.timestamp,
		});
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

/**
 * Merge `ours` and `theirs` over `base` into a tree, `ours` the device
 * syncing and so the change.
 *
 * Every unit the change won is `theirs` losing. Where `theirs` stands
 * whole at a path, it lost nothing there: a unit of it is `ours` losing,
 * as when this device's delete gave way to the remote's edit.
 */
export async function mergeHistories(
	access: ObjectAccess,
	{
		base,
		ours,
		theirs,
	}: {
		readonly base: string | undefined;
		readonly ours: string;
		readonly theirs: string;
	},
): Promise<HistoryMerge> {
	const b = base === undefined ? null : await commitTree(access, base);
	const current = await commitTree(access, theirs);
	const change = await commitTree(access, ours);
	const read = async (oid: string): Promise<GitObject> => {
		// Every repository names the empty tree without storing it.
		if (oid === EMPTY_TREE) return { type: 'tree', bytes: new Uint8Array() };
		const { type, object } = await git.readObject({
			...access,
			oid,
			format: 'content',
		});
		if (typeof object === 'string' || !(object instanceof Uint8Array))
			throw new Error(`Object ${oid} did not read as bytes`);
		return { type: type as GitObject['type'], bytes: object };
	};
	const merged = await mergeTrees({ base: b, current, change, read });
	for (const object of merged.objects.values())
		await git.writeObject({
			...access,
			type: object.type,
			object: object.bytes,
			format: 'content',
		});
	const tree =
		merged.tree === null || merged.tree === EMPTY_TREE
			? await git.writeTree({ ...access, tree: [] })
			: merged.tree;
	const overrides: Override[] = merged.overridden.map(
		({ path, unit, losing }) => ({
			path,
			unit,
			losing: losing === 'current' ? theirs : ours,
		}),
	);
	return { tree, overrides };
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
	const lines = overrides.map(({ path, unit, losing }) =>
		overrodeTrailer(losing, path, unit),
	);
	return `${subject}\n\n${lines.join('\n')}`;
}
