/**
 * Sync is a function of two stores and a manifest (ADR-0803):
 * `sync({ local, remote, manifest })`. `local` is any store (a folder's
 * directory, the open folder, the web's memory); `remote` is a repository's
 * history (`repository.ts`): where `main` is, what changed, a tree, blobs
 * by id, and a commit. No Git runs on this side.
 *
 * A file's version is its Git blob id on every store (ADR-0808), so the
 * manifest is `{ folder, root, commit, files }`: the repository it syncs with,
 * the directory it synced in,
 * the commit both sides last agreed at, and each file's agreed blob id. A
 * side changed a file when its version differs from the agreed one, and a
 * note both sides changed merges against the agreed blob, read by its id:
 * no file records the commit it agreed at. One sync runs passes:
 *
 * 1. Asks the repository what changed since `commit` (everything when the
 *    manifest names no commit, or one the repository no longer holds),
 *    lists the local store, and takes as candidates the paths changed on
 *    either side, with every path this sync committed earlier. It reads each
 *    candidate's blob at `main`'s head, so a candidate is judged by what is
 *    there, never by what changed.
 * 2. Copies a file changed on one side to the other. A note changed on
 *    both merges by `merge3` against its agreed blob; this computer's side
 *    is the later write. An attachment changed on both takes this
 *    computer's; an edit beats a delete; equal versions agree.
 * 3. Writes the local side first, each file over the version listed, so a
 *    file another program wrote meanwhile is `Moved` and kept for the next
 *    sync to merge. Then it commits to the repository in batches, each over
 *    the blobs read. A moved batch lands nothing: the sync lists again and
 *    runs another pass.
 * 4. A pass that committed is followed by one more, which reads again every
 *    path this sync committed and takes what others landed meanwhile; a
 *    pass that committed nothing agrees at the head it read, and the
 *    manifest moves there.
 *
 * The manifest is saved after the local writes (and after each merge
 * written there) and at the end, so a sync stopped anywhere reruns from
 * what landed: a merged note written locally is agreed at the repository's
 * blob it merged with, so it merges next time against that, never twice
 * into markers. Every save but the last names no commit: its files agree
 * at more than one, so the next sync compares every path by blob id rather
 * than trusting what changed since one.
 *
 * Two syncs of one folder may run at once (an app and the CLI), with no
 * lock: every write either makes is over the version it read, so the
 * second to write a file finds it `Moved` and keeps it. Each manifest save
 * is over the version its sync read too; one that finds another sync's
 * save reads it, lays over it the files whose write this sync landed,
 * saves that, and runs again from it (`savedManifest`).
 */
import {
	ClientError,
	isHiddenPath,
	isNotePath,
} from '@epicenter/definition/contract';
import { merge3 } from '@epicenter/definition/front-matter';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type BlobId,
	putLanded,
	type Store,
	type Unavailable,
	within,
} from '../device/store.js';
import type { CommitReceipt, Repository } from './repository.js';

/**
 * Which repository a folder syncs with: the folder's id, which the server
 * mints at its first sync. The one place a manifest names its repository;
 * `folderUrl` (`@epicenter/definition/site`) is the one place that becomes
 * an address.
 */
export type RepositoryAddress = { folder: string };

/**
 * The identity of the directory a folder synced in (ADR-0811): its device
 * and inode, which a move within a disk keeps and a copy does not. A
 * manifest records it beside the folder's id, so a copy of the directory
 * (a Finder duplicate, a backup restored elsewhere) is told apart from the
 * folder it was copied from before it syncs as that folder.
 */
export type RootIdentity = { device: string; inode: string };

export type Manifest = Partial<RepositoryAddress> & {
	/** The directory the folder synced in; absent where the store has no such identity (memory, the web). */
	root?: RootIdentity;
	/** The repository commit both sides last agreed at; null before the first sync, or after one that stopped. */
	commit: string | null;
	/** Each synced file's agreed version: its Git blob id, the same on both sides. */
	files: Record<string, BlobId>;
};

/** The version of a saved manifest, which the next save is written over; null before the first. */
export type ManifestVersion = BlobId | null;

/**
 * Where a manifest is kept between syncs. Each save is written over the
 * version its sync read, as any file is (ADR-0805), so two syncs of one
 * folder running at once never overwrite each other's manifest.
 */
export type ManifestStore = {
	read(): Promise<
		Result<{ manifest: Manifest; version: ManifestVersion }, Unavailable>
	>;
	/**
	 * Save `manifest` while the saved one is still at `expect`, answering
	 * the new version, or `'moved'` when another sync saved first, and
	 * nothing changed.
	 */
	write(
		manifest: Manifest,
		expect: ManifestVersion,
	): Promise<Result<BlobId | 'moved', Unavailable>>;
};

/** The manifest of a store never synced. */
export const emptyManifest = (): Manifest => ({ commit: null, files: {} });

/** Where a folder keeps its manifest, beside its files (ADR-0803). */
export const MANIFEST_PATH = '.epicenter/synced.json';

/** A manifest held in memory, for a test or the web's memory store. */
export function memoryManifest(initial: Manifest = emptyManifest()) {
	let current = structuredClone(initial);
	let version: ManifestVersion = null;
	let saves = 0;
	return {
		async read() {
			return Ok({ manifest: structuredClone(current), version });
		},
		async write(manifest: Manifest, expect: ManifestVersion) {
			if (expect !== version) return Ok('moved' as const);
			current = structuredClone(manifest);
			version = `saved-${++saves}` as BlobId;
			return Ok(version);
		},
		/** The manifest as last written. */
		current: () => structuredClone(current),
	} satisfies ManifestStore & { current(): Manifest };
}

/** The manifest kept at `MANIFEST_PATH` in `store`, read and written as any file there. */
export function storeManifest(store: Store): ManifestStore {
	return {
		async read() {
			const read = await store.read([MANIFEST_PATH]);
			if (read.error !== null) return read;
			const [file] = read.data;
			if (file === undefined || 'gone' in file)
				return Ok({ manifest: emptyManifest(), version: null });
			try {
				const manifest = JSON.parse(decoder.decode(file.bytes)) as Manifest;
				return Ok({ manifest, version: file.version });
			} catch (cause) {
				return ClientError.Unavailable({ cause });
			}
		},
		async write(manifest, expect) {
			const bytes = encoder.encode(JSON.stringify(manifest));
			const written = await putLanded(store, MANIFEST_PATH, bytes, expect);
			if (written.error?.name === 'Moved') return Ok('moved' as const);
			if (written.error !== null) return Err(written.error);
			if (written.data === null)
				return ClientError.Unavailable({
					cause: `the write of ${MANIFEST_PATH} landed nothing`,
				});
			return Ok(written.data);
		},
	};
}

/** What one sync did. `retry` when the repository kept moving under it for every pass. */
export type SyncReport = {
	outcome: 'synced' | 'retry';
	passes: number;
	/** Files copied from the repository to the local store. */
	pulled: string[];
	/** Files written to the repository. */
	pushed: string[];
	/** Notes changed on both sides and merged. */
	merged: string[];
	/** Merged notes whose body holds Git's conflict markers. */
	conflicts: string[];
	/** Files another program wrote locally during the sync: kept, and merged by the next one. */
	kept: string[];
	/**
	 * Files the repository refused, and why: a path that differs only in
	 * case from one it holds. Kept here, and refused again by every sync
	 * until a person renames one.
	 */
	refused: { path: string; reason: string }[];
};

const READ_CHUNK = 2000;
const WRITE_CHUNK = 500;
const WRITE_BYTES = 8 * 1024 * 1024;

const chunks = <T>(items: readonly T[], size: number) =>
	Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
		items.slice(index * size, (index + 1) * size),
	);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Sync `local` with `remote` from the state `manifest` holds, and move the
 * manifest to the state they agree on. At most `passes` passes: a pass
 * whose commit found the repository moved lists again.
 */
export async function sync({
	local,
	remote,
	manifest,
	passes = 4,
}: {
	local: Store;
	remote: Repository;
	manifest: ManifestStore;
	passes?: number;
}): Promise<Result<SyncReport, Unavailable>> {
	const read = await manifest.read();
	if (read.error !== null) return read;
	let state = read.data.manifest;
	const saved = savedManifest(manifest, read.data);
	const report: SyncReport = {
		outcome: 'retry',
		passes: 0,
		pulled: [],
		pushed: [],
		merged: [],
		conflicts: [],
		kept: [],
		refused: [],
	};
	/** Every path this sync committed: each later pass reads it again at the head. */
	const committed = new Set<string>();
	/** The local listing a pass reuses: the last pass's, with this sync's own writes. */
	let listing: Map<string, BlobId> | null = null;
	while (report.passes < passes) {
		report.passes++;
		const pushedBefore = report.pushed.length;
		const ran = await syncPass({
			local,
			remote,
			manifest: saved,
			state,
			report,
			listing,
			committed,
		});
		if (ran.error !== null) return ran;
		state = ran.data.state;
		report.outcome = ran.data.done ? 'synced' : 'retry';
		if (ran.data.done && report.pushed.length === pushedBefore) break;
		// A pass that pushed is followed by one that agrees at the head,
		// taking what others landed meanwhile. Only the repository moved: it
		// reuses this listing. A pass whose commit found it moved lists again.
		listing = ran.data.done ? ran.data.listing : null;
	}
	// A file a moved pass handled is handled again by the next: name it once.
	const once = (paths: string[]) => [...new Set(paths)];
	return Ok({
		...report,
		pulled: once(report.pulled),
		pushed: once(report.pushed),
		merged: once(report.merged),
		conflicts: once(report.conflicts),
		kept: once(report.kept),
		refused: [
			...new Map(report.refused.map((file) => [file.path, file])).values(),
		],
	});
}

/** What a sync landed: the agreed files, and the paths whose write landed. */
type Landings = {
	files: Record<string, BlobId>;
	landed: ReadonlySet<string>;
};

/**
 * The manifest as one sync saves it: over the version it last read or
 * saved. When another sync of the folder saved first, it reads that one,
 * lays over it, path by path, the files whose write this sync landed, and
 * saves that with no commit, since its files now agree at more than one:
 * this sync's landings are never lost or merged twice, and the other's
 * stand. The sync then runs again from what was saved.
 */
function savedManifest(
	store: ManifestStore,
	first: { manifest: Manifest; version: ManifestVersion },
) {
	let version = first.version;
	let current = JSON.stringify(first.manifest);
	return {
		/** Whether `next` is what the store holds already. */
		holds: (next: Manifest) => JSON.stringify(next) === current,
		/** Save `next`: null when it was saved as it is, else the manifest saved in its place. */
		async save(
			next: Manifest,
			landings: Landings,
		): Promise<Result<Manifest | null, Unavailable>> {
			let saving = next;
			for (let tries = 0; tries < 8; tries++) {
				const written = await store.write(saving, version);
				if (written.error !== null) return written;
				if (written.data !== 'moved') {
					version = written.data;
					current = JSON.stringify(saving);
					return Ok(saving === next ? null : saving);
				}
				const read = await store.read();
				if (read.error !== null) return read;
				version = read.data.version;
				saving = overlay(read.data.manifest, landings);
			}
			return ClientError.Unavailable({
				cause: `${MANIFEST_PATH} kept changing: other syncs of this folder are running`,
			});
		},
	};
}

/** `theirs`, with the file of each path in `landed` taken from this sync's, agreed at no one commit. */
function overlay(theirs: Manifest, { files, landed }: Landings): Manifest {
	const next = { ...theirs.files };
	for (const path of landed) {
		const version = files[path];
		if (version === undefined) delete next[path];
		else next[path] = version;
	}
	return { ...theirs, commit: null, files: next };
}

/** A change for the repository: a file's bytes, or null to delete it, where the path holds `expect`. */
type Push = {
	path: string;
	bytes: Uint8Array | null;
	/** The local version written: the manifest agrees at it once it lands. */
	local: BlobId | null;
	expect: BlobId | null;
};

async function syncPass({
	local,
	remote,
	manifest,
	state,
	report,
	listing,
	committed,
}: {
	local: Store;
	remote: Repository;
	manifest: ReturnType<typeof savedManifest>;
	state: Manifest;
	report: SyncReport;
	/** The local store's visible files and versions, when the last pass's still hold; null to list them. */
	listing: Map<string, BlobId> | null;
	/** Every path this sync committed, which this pass reads again. */
	committed: Set<string>;
}): Promise<
	Result<
		{ state: Manifest; done: boolean; listing: Map<string, BlobId> },
		Unavailable
	>
> {
	// 1. Where each side is.
	const since = await remote.changes(state.commit);
	if (since.error !== null) return since;
	const head = since.data.commit;
	const everything = since.data.paths === null;
	const files: Record<string, BlobId> = { ...state.files };
	/** Each candidate's blob at the head (absent: nothing there). */
	const theirs = new Map<string, BlobId>();
	if (everything && head !== null) {
		const tree = await remote.tree(head);
		if (tree.error !== null) return tree;
		for (const { path, blob } of tree.data) theirs.set(path, blob);
	}

	let found = listing;
	if (found === null) {
		const listed = await local.list(['']);
		if (listed.error !== null) return listed;
		found = new Map(
			listed.data
				.filter(({ path }) => !isHiddenPath(path))
				.map(({ path, version }) => [path, version]),
		);
	}
	const mine = found;
	/** What this pass found locally, then each version its own writes landed: the listing the next pass may reuse. */
	const after = new Map(mine);
	const wroteLocally = (path: string, version: BlobId | null) => {
		if (version === null) after.delete(path);
		else after.set(path, version);
	};

	const candidates = new Set<string>([
		...(since.data.paths ?? theirs.keys()),
		...committed,
	]);
	for (const [path, version] of mine)
		if (files[path] !== version) candidates.add(path);
	for (const path of Object.keys(files))
		if (everything || !mine.has(path)) candidates.add(path);
	// A file kept by an earlier pass waits for the next sync: what another
	// program wrote there may be a concurrent sync's merge, not yet recorded.
	const keptBefore = new Set(report.kept);
	const paths = [...candidates]
		.filter((path) => !isHiddenPath(path) && !keptBefore.has(path))
		.sort();

	// 2. Each candidate as the repository holds it at the head.
	if (!everything && head !== null)
		for (const chunk of chunks(paths, READ_CHUNK)) {
			const tree = await remote.tree(head, chunk);
			if (tree.error !== null) return tree;
			for (const { path, blob } of tree.data) theirs.set(path, blob);
		}
	const agreed = (path: string) => files[path] ?? null;
	/** Agree at what both sides hold: the manifest's file becomes it. */
	const settle = (path: string, version: BlobId | null) => {
		if (version === null) delete files[path];
		else files[path] = version;
	};

	const pulls: { path: string; local: BlobId | null; remote: BlobId | null }[] =
		[];
	const toPush: { path: string; expect: BlobId | null }[] = [];
	const toMerge: { path: string; remote: BlobId }[] = [];
	for (const path of paths) {
		const ours = mine.get(path) ?? null;
		const there = theirs.get(path) ?? null;
		if (ours === there) {
			settle(path, ours);
			continue;
		}
		const theirsChanged = there !== agreed(path);
		const oursChanged = ours !== agreed(path);
		// One side changed; when both did, an edit beats a delete, a note
		// merges, and any other file takes this computer's.
		if (!oursChanged || (theirsChanged && ours === null))
			pulls.push({ path, local: ours, remote: there });
		else if (!theirsChanged || there === null || !isNotePath(path))
			toPush.push({ path, expect: there });
		else toMerge.push({ path, remote: there });
	}

	// The local bytes of each push and merge.
	const needLocal = [
		...toPush.filter(({ path }) => mine.has(path)).map(({ path }) => path),
		...toMerge.map(({ path }) => path),
	];
	const ourBytes = new Map<string, { bytes: Uint8Array; version: BlobId }>();
	for (const chunk of chunks(needLocal, READ_CHUNK)) {
		const got = await local.read(chunk);
		if (got.error !== null) return got;
		for (const file of got.data)
			if (!('gone' in file)) ourBytes.set(file.path, file);
	}
	const pushes: Push[] = [];
	for (const { path, expect } of toPush) {
		const read = ourBytes.get(path);
		if (read !== undefined)
			pushes.push({ path, bytes: read.bytes, local: read.version, expect });
		// Gone since it was listed: the next sync takes it up.
		else if (!mine.has(path))
			pushes.push({ path, bytes: null, local: null, expect });
	}

	// Each merge: theirs at the head, against the agreed blob, both read by id.
	const wanted = toMerge.flatMap(({ path, remote: blob }) => {
		const base = agreed(path);
		return [{ path, blob }, ...(base === null ? [] : [{ path, blob: base }])];
	});
	const read = new Map<BlobId, Uint8Array>();
	for (const chunk of chunks(wanted, READ_CHUNK)) {
		const got = await remote.blobs(chunk);
		if (got.error !== null) return got;
		chunk.forEach(({ blob }, index) => {
			const bytes = got.data[index];
			if (bytes != null) read.set(blob, bytes);
		});
	}
	const merges: (Push & { bytes: Uint8Array; conflict: boolean })[] = [];
	for (const { path, remote: blob } of toMerge) {
		const ours = ourBytes.get(path);
		const theirBytes = read.get(blob);
		if (theirBytes === undefined)
			return ClientError.Unavailable({
				cause: `${path} could not be read at ${head}`,
			});
		// Gone since it was listed: the next sync takes it up.
		if (ours === undefined) continue;
		const base = agreed(path);
		const baseBytes = base === null ? undefined : read.get(base);
		const merged = merge3(
			baseBytes === undefined ? null : decoder.decode(baseBytes),
			decoder.decode(ours.bytes),
			decoder.decode(theirBytes),
			{ later: 'current' },
		);
		merges.push({
			path,
			bytes: encoder.encode(merged.text ?? ''),
			conflict: merged.conflict,
			local: ours.version,
			expect: blob,
		});
	}

	// 3. The local side first, so a write another program makes meanwhile is kept.
	/** The paths whose write this pass landed, on either side. */
	const landed = new Set<string>();
	/** Save `next`: null when it was saved as it is, else what another sync of this folder saved, with this pass's landings. */
	const save = (next: Manifest) => manifest.save(next, { files, landed });
	/** The manifest as it stands mid-sync: agreed at no one commit. */
	const midway = (): Manifest => ({ ...state, commit: null, files });
	/** The state the next pass starts from: candidates it reads again make it agree at this head. */
	const carried = (): Manifest => ({ ...state, commit: head, files });

	const kept: string[] = [];
	for (const merge of merges) {
		const written = await putLanded(
			local,
			merge.path,
			merge.bytes,
			merge.local,
		);
		if (written.error !== null && written.error.name !== 'Moved')
			return Err(written.error);
		if (written.error !== null || written.data === null) {
			kept.push(merge.path);
			continue;
		}
		wroteLocally(merge.path, written.data);
		// Merged here, not yet in the repository: agreed at the blob merged with.
		files[merge.path] = merge.expect as BlobId;
		landed.add(merge.path);
		report.merged.push(merge.path);
		if (merge.conflict) report.conflicts.push(merge.path);
		pushes.push({ ...merge, local: written.data });
		const saved = await save(midway());
		if (saved.error !== null) return saved;
		if (saved.data !== null)
			return Ok({ state: saved.data, done: false, listing: after });
	}

	const fetch = pulls.flatMap(({ path, remote: blob }) =>
		blob === null ? [] : [{ path, blob }],
	);
	const fetched = new Map<string, Uint8Array>();
	for (const chunk of chunks(fetch, READ_CHUNK)) {
		const got = await remote.blobs(chunk);
		if (got.error !== null) return got;
		chunk.forEach(({ path }, index) => {
			const bytes = got.data[index];
			if (bytes != null) fetched.set(path, bytes);
		});
	}
	for (const pull of pulls) {
		const bytes =
			pull.remote === null ? null : (fetched.get(pull.path) ?? null);
		if (pull.remote !== null && bytes === null)
			return ClientError.Unavailable({
				cause: `${pull.path} could not be read at ${head}`,
			});
		const written = await putLanded(local, pull.path, bytes, pull.local);
		if (written.error?.name === 'Moved') {
			kept.push(pull.path);
			continue;
		}
		if (written.error !== null) return Err(written.error);
		settle(pull.path, written.data);
		wroteLocally(pull.path, written.data);
		landed.add(pull.path);
		report.pulled.push(pull.path);
	}
	report.kept.push(...kept);
	if (pulls.length > 0 || kept.length > 0) {
		const saved = await save(midway());
		if (saved.error !== null) return saved;
		if (saved.data !== null)
			return Ok({ state: saved.data, done: false, listing: after });
	}

	// Then the repository, in batches of one commit each.
	const batches: Push[][] = [];
	let batch: Push[] = [];
	let size = 0;
	for (const push of pushes) {
		const bytes = push.bytes?.byteLength ?? 0;
		if (
			batch.length > 0 &&
			(batch.length >= WRITE_CHUNK || size + bytes > WRITE_BYTES)
		) {
			batches.push(batch);
			batch = [];
			size = 0;
		}
		batch.push(push);
		size += bytes;
	}
	if (batch.length > 0) batches.push(batch);
	let pushed = false;
	for (const group of batches) {
		const landedBatch = await commitBatch(remote, group, report);
		if (landedBatch.error !== null) return landedBatch;
		if (landedBatch.data === null) continue;
		if (landedBatch.data === 'moved') {
			const saved = await save(midway());
			if (saved.error !== null) return saved;
			return Ok({
				state: saved.data ?? carried(),
				done: false,
				listing: after,
			});
		}
		pushed = true;
		for (const push of landedBatch.data.pushes) {
			settle(push.path, push.local);
			committed.add(push.path);
			landed.add(push.path);
			report.pushed.push(push.path);
		}
	}

	// 4. A pass that committed is agreed by the next; one that did not agrees at the head it read.
	if (pushed) {
		const saved = await save(midway());
		if (saved.error !== null) return saved;
		return Ok({
			state: saved.data ?? carried(),
			done: saved.data === null,
			listing: after,
		});
	}
	const next = carried();
	if (manifest.holds(next))
		return Ok({ state: next, done: true, listing: after });
	const saved = await save(next);
	if (saved.error !== null) return saved;
	return Ok(
		saved.data === null
			? { state: next, done: true, listing: after }
			: { state: saved.data, done: false, listing: after },
	);
}

/**
 * Commit `pushes` to the repository, leaving out every path it refuses,
 * which `report` names: the pushes that landed with the receipt, `'moved'`
 * when a path moved, or null when every path was refused.
 */
async function commitBatch(
	remote: Repository,
	pushes: Push[],
	report: SyncReport,
): Promise<
	Result<
		{ pushes: Push[]; receipt: CommitReceipt } | 'moved' | null,
		Unavailable
	>
> {
	let writing = pushes;
	while (writing.length > 0) {
		const landed = await remote.commit(
			writing.map(({ path, bytes, expect }) => ({ path, bytes, expect })),
		);
		if (landed.error !== null) return landed;
		if (landed.data === 'moved') return Ok('moved');
		if (!('refused' in landed.data))
			return Ok({ pushes: writing, receipt: landed.data });
		// A path the repository will never take: report it, and write the rest.
		const { refused, reason } = landed.data;
		const out = writing.filter(({ path }) => within(path, [refused]));
		if (out.length === 0)
			return ClientError.Unavailable({
				cause: `the repository refused ${refused}, which this sync did not write: ${reason}`,
			});
		for (const { path } of out) report.refused.push({ path, reason });
		writing = writing.filter((push) => !out.includes(push));
	}
	return Ok(null);
}
