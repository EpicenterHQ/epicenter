/**
 * A repository's history: what `sync` needs of the place it syncs with
 * (ADR-0803), beyond the store verbs it never calls there. The server's
 * repository store answers it beside its store verbs (`remote/store.ts`),
 * and so does `memoryRepository`, the twin a test syncs two memory stores
 * through.
 *
 * A repository's version of a file is fixed by its bytes at a commit, so a
 * sync asks where the repository is, what changed since the commit both
 * sides last agreed at, and what a note held there: its base for a merge.
 * It writes a batch of files in one commit, each over the version its
 * writer read, or nothing; a batch adding a path that differs only in case
 * from one the repository holds is refused, naming that path (ADR-0804).
 */
import { ClientError, isNotePath } from '@epicenter/definition/contract';
import { Ok, type Result } from 'wellcrafted/result';
import type { BlobId, Listed, Unavailable } from '../device/store.js';
import { blobIdOf } from '../hash.js';

/** One file at a commit: its version and bytes (null for an attachment read without them), or gone. */
export type RemoteFile =
	| { path: string; version: BlobId; bytes: Uint8Array | null }
	| { path: string; gone: true };

/** One file of a batch write: its bytes, or null to delete it, over the version its writer expects there (null: nothing). */
export type BatchWrite = {
	path: string;
	bytes: Uint8Array | null;
	expect: BlobId | null;
};

/**
 * A batch the repository refused for one place, which no retry fixes: a
 * path that differs only in case from one it holds (`refused` is that
 * path, or the folder whose name clashes), and why.
 */
export type BatchRefusal = { refused: string; reason: string };

/** A batch that landed: its commit, and the version now at each path (null where a delete landed). */
export type BatchReceipt = {
	commit: string;
	versions: Record<string, BlobId | null>;
};

export type Repository = {
	/**
	 * The commit the repository is at (null before its first write), and
	 * the paths that changed since `since`: null when `since` is null or
	 * names no commit the repository holds.
	 */
	changes(
		since: string | null,
	): Promise<
		Result<{ commit: string | null; paths: string[] | null }, Unavailable>
	>;
	/** Every file, with the commit the listing is of. */
	snapshot(): Promise<
		Result<{ commit: string | null; files: Listed[] }, Unavailable>
	>;
	/**
	 * The files at `paths` as `commit` holds them, in order. An attachment's
	 * bytes come only with `attachments`; a note's always do.
	 */
	readAt(
		paths: readonly string[],
		commit: string,
		options: { attachments: boolean },
	): Promise<Result<RemoteFile[], Unavailable>>;
	/**
	 * Land every write in one commit, or none: `'stale'` when any path holds
	 * something other than its `over`, and a `BatchRefusal` when a path
	 * would differ only in case from one the repository then holds.
	 */
	writeAll(
		writes: readonly BatchWrite[],
	): Promise<Result<BatchReceipt | 'stale' | BatchRefusal, Unavailable>>;
};

/**
 * A repository in memory: each batch is a commit holding a copy of every
 * file, so any commit can be read. For tests, and the measure of what
 * `sync` costs without a disk or a network.
 */
export function memoryRepository() {
	type Tree = Map<string, { bytes: Uint8Array; version: BlobId }>;
	const commits = new Map<string, Tree>();
	let head: string | null = null;
	let count = 0;
	const tree = (commit: string | null): Tree =>
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
					} satisfies BatchRefusal;
			}
		}
		return null;
	}

	async function writeAll(
		writes: readonly BatchWrite[],
	): Promise<Result<BatchReceipt | 'stale' | BatchRefusal, Unavailable>> {
		const prepared = await Promise.all(
			writes.map(async (write) => ({
				...write,
				version:
					write.bytes === null ? null : await blobIdOf(write.path, write.bytes),
			})),
		);
		// No await from here: the check and the commit are one step.
		const current = tree(head);
		for (const { path, expect } of prepared)
			if ((current.get(path)?.version ?? null) !== expect) return Ok('stale');
		const next: Tree = new Map(current);
		const versions: Record<string, BlobId | null> = {};
		for (const { path, bytes, version } of prepared) {
			versions[path] = version;
			if (bytes === null || version === null) next.delete(path);
			else next.set(path, { bytes: bytes.slice(), version });
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
		return Ok({ commit, versions });
	}

	const repository = {
		async changes(since: string | null) {
			if (since === null || !commits.has(since))
				return Ok({ commit: head, paths: null });
			const before = tree(since);
			const after = tree(head);
			const paths = [...new Set([...before.keys(), ...after.keys()])]
				.filter(
					(path) => before.get(path)?.version !== after.get(path)?.version,
				)
				.sort();
			return Ok({ commit: head, paths });
		},
		async snapshot() {
			return Ok({
				commit: head,
				files: [...tree(head)].map(([path, { bytes, version }]) => ({
					path,
					version,
					size: bytes.byteLength,
				})),
			});
		},
		async readAt(
			paths: readonly string[],
			commit: string,
			{ attachments }: { attachments: boolean },
		) {
			if (!commits.has(commit))
				return ClientError.Unavailable({ cause: `no commit ${commit}` });
			const at = tree(commit);
			return Ok(
				paths.map((path): RemoteFile => {
					const file = at.get(path);
					if (file === undefined) return { path, gone: true };
					const withBytes = attachments || isNotePath(path);
					return {
						path,
						version: file.version,
						bytes: withBytes ? file.bytes.slice() : null,
					};
				}),
			);
		},
		writeAll,
	} satisfies Repository;
	return repository;
}
