/**
 * A repository's history: what `sync` needs of the place it syncs with
 * (ADR-0803), in Git's own vocabulary (ADR-0808). The server's repository
 * answers it (`remote/repository.ts`), and so does `memoryRepository`, the
 * twin a test syncs two memory stores through.
 *
 * A file's version is its Git blob id, the same on every store, so a sync
 * asks where `main` is and which paths changed since the commit both sides
 * last agreed at (`changes`), the blob each path holds at a commit
 * (`tree`), and a blob's bytes by its id (`blobs`): a note's base for a
 * merge is the blob the manifest agreed on, read by id. It lands a batch of
 * files in one commit, each only where the path still holds the blob its
 * writer expects (`commit`), or nothing; a batch adding a path that differs
 * only in case from one the repository holds is refused, naming that path
 * (ADR-0804).
 */
import { ClientError } from '@epicenter/definition/contract';
import { Ok, type Result } from 'wellcrafted/result';
import type { BlobId, Unavailable } from '../device/store.js';
import { blobIdOf } from '../hash.js';

/** One file in a tree: the blob at its path, and its size where the repository knows it without reading (an attachment's, from its pointer). */
export type TreeEntry = { path: string; blob: BlobId; size: number | null };

/** One file of a commit: its bytes, or null to delete it, where the path holds the blob its writer expects (null: nothing). */
export type CommitWrite = {
	path: string;
	bytes: Uint8Array | null;
	expect: BlobId | null;
};

/**
 * A commit the repository refused for one place, which no retry fixes: a
 * path that differs only in case from one it holds (`refused` is that
 * path, or the folder whose name clashes), and why.
 */
export type CommitRefusal = { refused: string; reason: string };

/** A commit that landed: its id, and the blob now at each path (null where a delete landed). */
export type CommitReceipt = {
	commit: string;
	blobs: Record<string, BlobId | null>;
};

export type Repository = {
	/**
	 * The commit `main` is at (null before the repository's first write),
	 * and the paths whose blob changed since `since`: null when `since` is
	 * null or names no commit the repository holds.
	 */
	changes(
		since: string | null,
	): Promise<
		Result<{ commit: string | null; paths: string[] | null }, Unavailable>
	>;
	/** The entries `commit`'s tree holds at `paths`, or every entry when `paths` is not given; a path it does not hold is left out. */
	tree(
		commit: string,
		paths?: readonly string[],
	): Promise<Result<TreeEntry[], Unavailable>>;
	/**
	 * The bytes of each blob, in order: a note's bytes by its blob id, an
	 * attachment's by its pointer's (`path` says which it is), or null for
	 * a blob the repository does not hold.
	 */
	blobs(
		wanted: readonly { path: string; blob: BlobId }[],
	): Promise<Result<(Uint8Array | null)[], Unavailable>>;
	/**
	 * Land every write in one commit on `main`, or none: `'moved'` when any
	 * path holds something other than its `expect`, and a `CommitRefusal`
	 * when a path would differ only in case from one the repository then
	 * holds.
	 */
	commit(
		writes: readonly CommitWrite[],
	): Promise<Result<CommitReceipt | 'moved' | CommitRefusal, Unavailable>>;
};

/**
 * A repository in memory: each commit holds every file's blob id, and
 * every blob ever committed is kept by its id. For tests, and the measure
 * of what `sync` costs without a disk or a network.
 */
export function memoryRepository() {
	type Tree = Map<string, BlobId>;
	const commits = new Map<string, Tree>();
	const blobs = new Map<BlobId, Uint8Array>();
	let head: string | null = null;
	let count = 0;
	const treeOf = (commit: string | null): Tree =>
		commit === null ? new Map() : (commits.get(commit) ?? new Map());

	/**
	 * The first place an added path names (itself, or a folder on its way)
	 * that differs only in case from another place `next` holds, as the
	 * server's `caseClash` finds it, or null.
	 */
	function caseClash(next: Tree, added: readonly string[]) {
		const fold = (place: string) => place.normalize('NFC').toLowerCase();
		const places = new Map<string, Set<string>>();
		for (const path of next.keys()) {
			const segments = path.split('/');
			for (let end = 1; end <= segments.length; end++) {
				const place = segments.slice(0, end).join('/');
				const same = places.get(fold(place)) ?? new Set<string>();
				same.add(place);
				places.set(fold(place), same);
			}
		}
		for (const path of added) {
			const segments = path.split('/');
			for (let end = 1; end <= segments.length; end++) {
				const place = segments.slice(0, end).join('/');
				const held = [...(places.get(fold(place)) ?? [])].find(
					(other) => other !== place,
				);
				if (held !== undefined)
					return {
						refused: place,
						reason: `${place} differs only in case from ${held}, which the repository holds: a disk that ignores case cannot keep them apart`,
					} satisfies CommitRefusal;
			}
		}
		return null;
	}

	return {
		async changes(since: string | null) {
			if (since === null || !commits.has(since))
				return Ok({ commit: head, paths: null });
			const before = treeOf(since);
			const after = treeOf(head);
			const paths = [...new Set([...before.keys(), ...after.keys()])]
				.filter((path) => before.get(path) !== after.get(path))
				.sort();
			return Ok({ commit: head, paths });
		},
		async tree(commit: string, paths?: readonly string[]) {
			if (!commits.has(commit))
				return ClientError.Unavailable({ cause: `no commit ${commit}` });
			const at = treeOf(commit);
			const entries: TreeEntry[] = [];
			for (const path of paths ?? [...at.keys()]) {
				const blob = at.get(path);
				if (blob !== undefined)
					entries.push({
						path,
						blob,
						size: blobs.get(blob)?.byteLength ?? null,
					});
			}
			return Ok(entries);
		},
		async blobs(wanted: readonly { path: string; blob: BlobId }[]) {
			return Ok(wanted.map(({ blob }) => blobs.get(blob)?.slice() ?? null));
		},
		async commit(
			writes: readonly CommitWrite[],
		): Promise<Result<CommitReceipt | 'moved' | CommitRefusal, Unavailable>> {
			const prepared = await Promise.all(
				writes.map(async (write) => ({
					...write,
					blob:
						write.bytes === null
							? null
							: await blobIdOf(write.path, write.bytes),
				})),
			);
			// No await from here: the check and the commit are one step.
			const current = treeOf(head);
			for (const { path, expect } of prepared)
				if ((current.get(path) ?? null) !== expect) return Ok('moved');
			const next: Tree = new Map(current);
			const landed: Record<string, BlobId | null> = {};
			for (const { path, bytes, blob } of prepared) {
				landed[path] = blob;
				if (bytes === null || blob === null) next.delete(path);
				else {
					next.set(path, blob);
					blobs.set(blob, bytes.slice());
				}
			}
			const clash = caseClash(
				next,
				prepared
					.filter(({ path, bytes }) => bytes !== null && !current.has(path))
					.map(({ path }) => path),
			);
			if (clash !== null) return Ok(clash);
			const commit = `c${++count}`;
			commits.set(commit, next);
			head = commit;
			return Ok({ commit, blobs: landed });
		},
	} satisfies Repository;
}
