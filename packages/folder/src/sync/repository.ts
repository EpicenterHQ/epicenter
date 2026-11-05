/**
 * A store with history: what `sync` needs of the place it syncs with
 * (ADR-0803). The server's repository answers it (`remote/store.ts`), and
 * so does `memoryRepository`, the twin a test syncs two memory stores
 * through.
 *
 * A repository's version of a file is fixed by its bytes at a commit, so a
 * sync asks where the repository is, what changed since the commit both
 * sides last agreed at, and what a note held there: its base for a merge.
 * It writes a batch of files in one commit, each over the version its
 * writer read, or nothing.
 */
import { ClientError, isNotePath } from '@epicenter/definition/contract';
import { Ok, type Result } from 'wellcrafted/result';
import type { Listed, Store, Unavailable, Version } from '../device/store.js';
import { within } from '../device/store.js';
import { hashBytes } from '../hash.js';

/** One file at a commit: its version and bytes (null for an attachment read without them), or gone. */
export type RemoteFile =
	| { path: string; version: Version; bytes: Uint8Array | null }
	| { path: string; gone: true };

/** One file of a batch write: its bytes, or null to delete it, over the version its writer read. */
export type BatchWrite = {
	path: string;
	bytes: Uint8Array | null;
	over: Version | 'absent';
};

/** A batch that landed: its commit, and the version now at each path (null where a delete landed). */
export type BatchReceipt = {
	commit: string;
	versions: Record<string, Version | null>;
};

export type Repository = Store & {
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
	 * something other than its `over`.
	 */
	writeAll(
		writes: readonly BatchWrite[],
	): Promise<Result<BatchReceipt | 'stale', Unavailable>>;
};

/**
 * A repository in memory: each batch is a commit holding a copy of every
 * file, so any commit can be read. For tests, and the measure of what
 * `sync` costs without a disk or a network.
 */
export function memoryRepository() {
	type Tree = Map<string, { bytes: Uint8Array; version: Version }>;
	const commits = new Map<string, Tree>();
	let head: string | null = null;
	let count = 0;
	const tree = (commit: string | null): Tree =>
		commit === null ? new Map() : (commits.get(commit) ?? new Map());

	async function writeAll(
		writes: readonly BatchWrite[],
	): Promise<Result<BatchReceipt | 'stale', Unavailable>> {
		const prepared = await Promise.all(
			writes.map(async (write) => ({
				...write,
				version:
					write.bytes === null
						? null
						: ((await hashBytes(write.bytes)) as Version),
			})),
		);
		// No await from here: the check and the commit are one step.
		const current = tree(head);
		for (const { path, over } of prepared) {
			const there = current.get(path)?.version;
			if (over === 'absent' ? there !== undefined : there !== over)
				return Ok('stale');
		}
		const next: Tree = new Map(current);
		const versions: Record<string, Version | null> = {};
		for (const { path, bytes, version } of prepared) {
			versions[path] = version;
			if (bytes === null || version === null) next.delete(path);
			else next.set(path, { bytes: bytes.slice(), version });
		}
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
		async list(under: readonly string[]) {
			return Ok(
				[...tree(head)]
					.filter(([path]) => within(path, under))
					.map(([path, { bytes, version }]) => ({
						path,
						version,
						size: bytes.byteLength,
					})),
			);
		},
		async read(paths: readonly string[]) {
			const at = tree(head);
			return Ok(
				paths.map((path) => {
					const file = at.get(path);
					return file === undefined
						? { path, gone: true as const }
						: { path, bytes: file.bytes.slice(), version: file.version };
				}),
			);
		},
		async write(
			path: string,
			bytes: Uint8Array | null,
			over: Version | 'absent',
		) {
			const written = await writeAll([{ path, bytes, over }]);
			if (written.error !== null) return written;
			if (written.data === 'stale') return Ok('stale' as const);
			return Ok(written.data.versions[path] ?? null);
		},
		async watch() {
			return Ok(() => {});
		},
		close() {},
	} satisfies Repository;
	return repository;
}
