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
 *
 * A path the folder keeps local is in no merge commit (ADR-0577), tracked
 * on either side or not.
 */
import * as git from 'isomorphic-git';
import type { Overridden } from '../shared/merge.js';
import { commitTree, EMPTY_TREE, type ObjectAccess } from './objects.js';
import {
	type GitObject,
	readTree,
	type TreeEntry,
	writeTree,
} from './raw-objects.js';
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

/**
 * The tree of `commit` without the paths `isLocal` names, or `null` for no
 * commit. A tree that holds none is the commit's own.
 */
async function sharedTree(
	access: ObjectAccess,
	commit: string | undefined,
	isLocal: (path: string) => boolean,
): Promise<string | null> {
	if (commit === undefined) return null;
	const tree = await commitTree(access, commit);
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	async function prune(oid: string, prefix: string): Promise<string> {
		if (prefix !== '' && isLocal(prefix)) return EMPTY_TREE;
		if (oid === EMPTY_TREE) return oid;
		const object = await git.readObject({ ...access, oid, format: 'content' });
		if (object.type !== 'tree' || !(object.object instanceof Uint8Array))
			throw new Error(`Expected tree object ${oid}`);
		let changed = false;
		const kept: TreeEntry[] = [];
		for (const entry of readTree(object.object)) {
			let name: string;
			try {
				name = decoder.decode(entry.name);
			} catch {
				// A local pattern cannot name undecodable bytes. Keep the entry exact.
				kept.push(entry);
				continue;
			}
			const path = `${prefix}${name}`;
			if (entry.mode !== '40000' && entry.mode !== '040000') {
				if (isLocal(path)) changed = true;
				else kept.push(entry);
				continue;
			}
			const child = await prune(entry.oid, `${path}/`);
			if (child === entry.oid) kept.push(entry);
			else {
				changed = true;
				if (child !== EMPTY_TREE) kept.push({ ...entry, oid: child });
			}
		}
		if (!changed) return oid;
		return git.writeObject({
			...access,
			type: 'tree',
			object: writeTree(kept),
			format: 'content',
		});
	}
	return prune(tree, '');
}

/**
 * Merge `ours` and `theirs` over `base` into a tree, `ours` the device
 * syncing and so the change. `isLocal` names the paths kept out of every
 * commit.
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
		isLocal,
	}: {
		readonly base: string | undefined;
		readonly ours: string;
		readonly theirs: string;
		readonly isLocal: (path: string) => boolean;
	},
): Promise<HistoryMerge> {
	const [b, current, change] = await Promise.all([
		sharedTree(access, base, isLocal),
		sharedTree(access, theirs, isLocal),
		sharedTree(access, ours, isLocal),
	]);
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
