/**
 * A folder's history on the server: what `sync` needs of the place it syncs
 * with (ADR-0803, ADR-0824). The server answers it (`remote/repository.ts`),
 * and so does `memoryRepository`, the twin a test syncs two memory stores
 * through.
 *
 * A file's version is the SHA-256 of its bytes, the same on every store, so
 * a sync asks which paths changed since the cursor both sides last agreed at,
 * each with its version now (`changes`), every file when it cannot tell
 * (`files`), and bytes by version (`blobs`): a note's base for a merge is the
 * version the manifest agreed on, read by it. It lands a batch of files in
 * one change, each only where the path still holds the version its writer
 * expects (`commit`), or nothing; a batch adding a path that differs only in
 * case from one the folder holds is refused, naming that path (ADR-0804).
 */
import { Ok, type Result } from 'wellcrafted/result';
import type { Unavailable, Version } from '../device/store.js';
import { versionOf } from '../hash.js';

/** A path whose version changed: its version now, null when it was deleted. */
export type ChangedPath = { path: string; version: Version | null };

/** One file the folder holds: its version, and its size. */
export type FileEntry = { path: string; version: Version; size: number | null };

/** One file of a commit: its bytes, or null to delete it, where the path holds the version its writer expects (null: nothing). */
export type CommitWrite = {
	path: string;
	bytes: Uint8Array | null;
	expect: Version | null;
};

/**
 * A commit the folder refused for one place, which no retry fixes: a path
 * that differs only in case from one it holds (`refused` is that path, or
 * the folder whose name clashes), and why.
 */
export type CommitRefusal = { refused: string; reason: string };

/** A commit that landed: the log's head after it, and the version now at each path (null where a delete landed). */
export type CommitReceipt = {
	cursor: string;
	versions: Record<string, Version | null>;
};

/** A commit that landed nothing: every path that held something other than its writer expected, and what. */
export type CommitMoved = {
	moved: { path: string; now: Version | null }[];
};

export type Repository = {
	/**
	 * The log's head as a cursor, and each path whose version changed since
	 * `since` with its version now: null ("compare every path") when `since`
	 * is null, names no point of this log, or is too far behind.
	 */
	changes(
		since: string | null,
	): Promise<
		Result<{ cursor: string; changes: ChangedPath[] | null }, Unavailable>
	>;
	/** Every file the folder holds now, and the cursor they are as of. */
	files(): Promise<Result<{ cursor: string; files: FileEntry[] }, Unavailable>>;
	/** The bytes of each version, in order: null for one the folder holds no bytes for. */
	blobs(
		versions: readonly Version[],
	): Promise<Result<(Uint8Array | null)[], Unavailable>>;
	/**
	 * Land every write in one change, or none: `CommitMoved` when any path
	 * holds something other than its `expect`, and a `CommitRefusal` when a
	 * path would differ only in case from one the folder then holds.
	 */
	commit(
		writes: readonly CommitWrite[],
	): Promise<Result<CommitReceipt | CommitMoved | CommitRefusal, Unavailable>>;
};

/** The most paths `changes` answers before it answers "compare every path". */
const CHANGES_LIMIT = 2000;

/**
 * A folder's log in memory: each change keeps the versions it wrote, and
 * every version ever committed keeps its bytes. For tests, and the measure
 * of what `sync` costs without a disk or a network.
 */
export function memoryRepository({
	changesLimit = CHANGES_LIMIT,
}: {
	changesLimit?: number;
} = {}) {
	const epoch = 'memory';
	const log: Map<string, Version | null>[] = [];
	const current = new Map<string, Version>();
	const bytesOf = new Map<Version, Uint8Array>();
	const cursor = () => `${epoch}.${log.length}`;

	/**
	 * The first place an added path names (itself, or a folder on its way)
	 * that differs only in case from another place `next` holds, as the
	 * server's commit finds it, or null.
	 */
	function caseClash(next: Map<string, Version>, added: readonly string[]) {
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
						reason: `${place} differs only in case from ${held}, which the folder holds: a disk that ignores case cannot keep them apart`,
					} satisfies CommitRefusal;
			}
		}
		return null;
	}

	return {
		async changes(since: string | null) {
			const match = since === null ? null : /^memory\.(\d+)$/.exec(since);
			const from = match === null ? null : Number(match[1]);
			if (from === null || from > log.length)
				return Ok({ cursor: cursor(), changes: null });
			const changed = new Map<string, Version | null>();
			for (const change of log.slice(from))
				for (const [path, version] of change) changed.set(path, version);
			if (changed.size > changesLimit)
				return Ok({ cursor: cursor(), changes: null });
			return Ok({
				cursor: cursor(),
				changes: [...changed]
					.map(([path, version]) => ({ path, version }))
					.sort((a, b) => (a.path < b.path ? -1 : 1)),
			});
		},
		async files() {
			return Ok({
				cursor: cursor(),
				files: [...current]
					.map(([path, version]) => ({
						path,
						version,
						size: bytesOf.get(version)?.byteLength ?? null,
					}))
					.sort((a, b) => (a.path < b.path ? -1 : 1)),
			});
		},
		async blobs(versions: readonly Version[]) {
			return Ok(
				versions.map((version) => bytesOf.get(version)?.slice() ?? null),
			);
		},
		async commit(
			writes: readonly CommitWrite[],
		): Promise<
			Result<CommitReceipt | CommitMoved | CommitRefusal, Unavailable>
		> {
			const prepared = await Promise.all(
				writes.map(async (write) => ({
					...write,
					version: write.bytes === null ? null : await versionOf(write.bytes),
				})),
			);
			// No await from here: the check and the commit are one step.
			const moved = prepared
				.filter(({ path, expect }) => (current.get(path) ?? null) !== expect)
				.map(({ path }) => ({ path, now: current.get(path) ?? null }));
			if (moved.length > 0) return Ok({ moved });
			const next = new Map(current);
			const versions: Record<string, Version | null> = {};
			const change = new Map<string, Version | null>();
			for (const { path, bytes, version, expect } of prepared) {
				versions[path] = version;
				if (version === expect) continue;
				change.set(path, version);
				if (bytes === null || version === null) next.delete(path);
				else {
					next.set(path, version);
					bytesOf.set(version, bytes.slice());
				}
			}
			const clash = caseClash(
				next,
				prepared
					.filter(({ path, bytes }) => bytes !== null && !current.has(path))
					.map(({ path }) => path),
			);
			if (clash !== null) return Ok(clash);
			if (change.size > 0) {
				log.push(change);
				current.clear();
				for (const [path, version] of next) current.set(path, version);
			}
			return Ok({ cursor: cursor(), versions });
		},
	} satisfies Repository;
}
