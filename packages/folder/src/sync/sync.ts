/**
 * Sync is a function of two stores and a manifest (ADR-0803):
 * `sync({ local, remote, manifest })`. `local` is any store (a folder's
 * directory, the web's memory); `remote` is a repository's history
 * (`repository.ts`): where it is, what changed, a file at a commit, and a
 * batch write. Of the remote's store verbs, a sync needs none. No Git runs
 * on this side.
 *
 * The manifest is the last state both sides agreed on: the repository's
 * `commit`, and each file's local `version` there. Within a sync a file
 * agreed at another commit (one this computer pushed, or one it kept)
 * carries its own base in `at`. One sync runs passes:
 *
 * 1. Asks the repository what changed since `commit` (everything on first
 *    contact), lists the local store, and compares each with the manifest.
 *    A file agreed at another commit that the repository did not change
 *    since is settled without reading it.
 * 2. Copies a file changed on one side to the other. A note changed on
 *    both merges by `merge3` against its base, read from the repository
 *    at the commit it agreed at; this computer's side is the later write.
 *    An attachment changed on both takes this computer's; an edit beats a
 *    delete.
 * 3. Writes the local side first, each file over the version listed, so a
 *    file another program wrote meanwhile is `'stale'` and kept for the
 *    next sync to merge. Then it writes the repository in batches, each
 *    one commit over the versions read. A stale batch lands nothing: the
 *    sync lists again and runs another pass.
 * 4. Moves the manifest to the commit it read at. A pass that pushed is
 *    followed by one more, which takes what others landed meanwhile and
 *    agrees at the head, so a finished sync's manifest is one `commit` and
 *    `files`, with `at` only for a file it kept.
 *
 * The manifest is saved after the local writes (and after each merge
 * written there) and at the end, so a sync stopped anywhere reruns from
 * what landed: a merged note written locally merges next time against the
 * repository's version it already holds, never twice into markers. Such a
 * save may need `at`: a merged note is agreed at the head, while a note
 * kept in the same pass is still agreed at the commit before.
 *
 * Two syncs of one folder may run at once (an app and the CLI), with no
 * lock: every write either makes is over the version it read, so the
 * second to write a file finds it `'stale'` and keeps it. Each manifest
 * save is over the version its sync read too; one that finds another
 * sync's save reads it, lays over it the files whose write this sync
 * landed, saves that, and runs again from it (`savedManifest`).
 */
import {
	ClientError,
	isHiddenPath,
	isNotePath,
} from '@epicenter/definition/contract';
import { merge3 } from '@epicenter/definition/front-matter';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type Store,
	type Unavailable,
	type Version,
	within,
} from '../device/store.js';
import type { BatchReceipt, RemoteFile, Repository } from './repository.js';

/** Where a file's agreed state is: a commit (null: before the first) and the version the repository held there (null: nothing). */
export type Base = { commit: string | null; version: Version | null };

export type Manifest = {
	/** The repository commit both sides last agreed at; null before the first sync. */
	commit: string | null;
	/** Each synced file's local version at that agreement. */
	files: Record<string, Version>;
	/** Files whose agreed state is at another commit than `commit`. */
	at?: Record<string, Base>;
};

/** The version of a saved manifest, which the next save is written over; `'absent'` before the first. */
export type ManifestVersion = Version | 'absent';

/**
 * Where a manifest is kept between syncs. Each save is written over the
 * version its sync read, as any file is (ADR-0798), so two syncs of one
 * folder running at once never overwrite each other's manifest.
 */
export type ManifestStore = {
	read(): Promise<
		Result<{ manifest: Manifest; version: ManifestVersion }, Unavailable>
	>;
	/**
	 * Save `manifest` while the saved one is still at `over`, answering the
	 * new version, or `'stale'` when another sync saved first, and nothing
	 * changed.
	 */
	write(
		manifest: Manifest,
		over: ManifestVersion,
	): Promise<Result<Version | 'stale', Unavailable>>;
};

/** The manifest of a store never synced. */
export const emptyManifest = (): Manifest => ({ commit: null, files: {} });

/** Where a folder keeps its manifest, beside its files (ADR-0803). */
export const MANIFEST_PATH = '.epicenter/synced.json';

/** A manifest held in memory, for a test or the web's memory store. */
export function memoryManifest(initial: Manifest = emptyManifest()) {
	let current = structuredClone(initial);
	let version: ManifestVersion = 'absent';
	let saves = 0;
	return {
		async read() {
			return Ok({ manifest: structuredClone(current), version });
		},
		async write(manifest: Manifest, over: ManifestVersion) {
			if (over !== version) return Ok('stale' as const);
			current = structuredClone(manifest);
			version = `saved-${++saves}` as Version;
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
				return Ok({ manifest: emptyManifest(), version: 'absent' as const });
			try {
				const manifest = JSON.parse(decoder.decode(file.bytes)) as Manifest;
				return Ok({ manifest, version: file.version });
			} catch (cause) {
				return ClientError.Unavailable({ cause });
			}
		},
		async write(manifest, over) {
			const bytes = encoder.encode(JSON.stringify(manifest));
			const written = await store.write(MANIFEST_PATH, bytes, over);
			if (written.error !== null) return written;
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

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
	a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Sync `local` with `remote` from the state `manifest` holds, and move the
 * manifest to the state they agree on. At most `passes` passes: a pass
 * whose repository write went stale lists again.
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
	const saved = savedManifest(manifest, read.data.version);
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
	/** The local listing a pass reuses: the last pass's, with this sync's own writes. */
	let listing: Map<string, Version> | null = null;
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
		});
		if (ran.error !== null) return ran;
		state = ran.data.state;
		report.outcome = ran.data.done ? 'synced' : 'retry';
		if (ran.data.done && report.pushed.length === pushedBefore) break;
		// A pass that pushed is followed by one that agrees at the head it
		// pushed to, taking what others landed meanwhile, so one commit names
		// the agreed state. Only the repository moved: it reuses this listing.
		// A pass whose write went stale lists again.
		listing = ran.data.done ? ran.data.listing : null;
	}
	// A file a stale pass handled is handled again by the next: name it once.
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

/** What a sync landed in one pass: the files and bases it holds, and the paths whose write landed. */
type Landings = {
	files: Record<string, Version>;
	at: Record<string, Base>;
	landed: ReadonlySet<string>;
};

/**
 * The manifest as one sync saves it: over the version it last read or
 * saved. When another sync of the folder saved first, it reads that one,
 * lays over it, path by path, the files whose write this sync landed, each
 * with the base it agreed at, and saves that: this sync's landings are
 * never lost or merged twice, and the other's stand. The sync then runs
 * again from what was saved.
 */
function savedManifest(store: ManifestStore, first: ManifestVersion) {
	let version = first;
	return {
		/** Save `next`: null when it was saved as it is, else the manifest saved in its place. */
		async save(
			next: Manifest,
			landings: Landings,
		): Promise<Result<Manifest | null, Unavailable>> {
			let saving = next;
			for (let tries = 0; tries < 8; tries++) {
				const written = await store.write(saving, version);
				if (written.error !== null) return written;
				if (written.data !== 'stale') {
					version = written.data;
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

/** `theirs`, with the file and base of each path in `landed` taken from this sync's. */
function overlay(theirs: Manifest, { files, at, landed }: Landings): Manifest {
	const nextFiles = { ...theirs.files };
	const nextAt = { ...theirs.at };
	for (const path of landed) {
		const version = files[path];
		if (version === undefined) delete nextFiles[path];
		else nextFiles[path] = version;
		const base = at[path];
		if (base !== undefined) nextAt[path] = base;
	}
	return Object.keys(nextAt).length === 0
		? { commit: theirs.commit, files: nextFiles }
		: { commit: theirs.commit, files: nextFiles, at: nextAt };
}

/** What a pass decided for one path. */
type Step =
	| {
			kind: 'settle';
			path: string;
			local: Version | null;
			remote: Version | null;
	  }
	| { kind: 'pull'; path: string; local: Version | null; remote: RemoteFile }
	| {
			kind: 'push';
			path: string;
			bytes: Uint8Array | null;
			local: Version | null;
			over: Version | 'absent';
	  }
	| {
			kind: 'merge';
			path: string;
			bytes: Uint8Array;
			conflict: boolean;
			local: Version;
			remote: Version;
	  };

async function syncPass({
	local,
	remote,
	manifest,
	state,
	report,
	listing,
}: {
	local: Store;
	remote: Repository;
	manifest: ReturnType<typeof savedManifest>;
	state: Manifest;
	report: SyncReport;
	/** The local store's visible files and versions, when the last pass's still hold; null to list them. */
	listing: Map<string, Version> | null;
}): Promise<
	Result<
		{ state: Manifest; done: boolean; listing: Map<string, Version> },
		Unavailable
	>
> {
	// 1. Where each side is.
	const since = await remote.changes(state.commit);
	if (since.error !== null) return since;
	let head = since.data.commit;
	const changedRemote =
		since.data.paths === null ? null : new Set(since.data.paths);
	let everyRemote: string[] = [];
	if (changedRemote === null) {
		const snapshot = await remote.snapshot();
		if (snapshot.error !== null) return snapshot;
		head = snapshot.data.commit;
		everyRemote = snapshot.data.files.map(({ path }) => path);
	}
	// A commit the repository no longer holds: meet it again as first contact.
	const lost = changedRemote === null && state.commit !== null;
	const files: Record<string, Version> = lost ? {} : { ...state.files };
	const at: Record<string, Base> = lost ? {} : { ...state.at };
	const baseCommit = changedRemote === null ? null : state.commit;

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
	const localNow = found;
	/** What this pass found locally, then each version its own writes landed: the listing the next pass may reuse. */
	const after = new Map(localNow);
	const wrote = (path: string, version: Version | null) => {
		if (version === null) after.delete(path);
		else after.set(path, version);
	};

	const candidates = new Set<string>([
		...(changedRemote ?? everyRemote),
		...Object.keys(at),
	]);
	for (const [path, version] of localNow)
		if (files[path] !== version) candidates.add(path);
	for (const path of Object.keys(files))
		if (!localNow.has(path)) candidates.add(path);
	// A file kept by an earlier pass waits for the next sync: what another
	// program wrote there may be a concurrent sync's merge, not yet recorded.
	const keptBefore = new Set(report.kept);
	const paths = [...candidates]
		.filter((path) => !isHiddenPath(path) && !keptBefore.has(path))
		.sort();
	const localChanged = (path: string) =>
		(localNow.get(path) ?? null) !== (files[path] ?? null);

	// 2. Each candidate as the repository holds it now, and as it was agreed.
	// A file agreed at another commit that neither side changed since is
	// settled without reading it: the repository names what changed there.
	const changedSince = new Map<string, Set<string> | null>();
	for (const { commit } of Object.values(at))
		if (commit !== null && commit !== head && !changedSince.has(commit)) {
			const got = await remote.changes(commit);
			if (got.error !== null) return got;
			changedSince.set(
				commit,
				got.data.paths === null ? null : new Set(got.data.paths),
			);
		}
	const quiet = (path: string) => {
		const agreed = at[path];
		if (agreed?.commit == null || localChanged(path)) return false;
		if (agreed.commit === head) return true;
		const since = changedSince.get(agreed.commit);
		return since != null && !since.has(path);
	};
	const remoteNow = new Map<string, RemoteFile>();
	for (const path of paths) {
		const agreed = at[path];
		if (agreed === undefined || !quiet(path)) continue;
		remoteNow.set(
			path,
			agreed.version === null
				? { path, gone: true }
				: { path, version: agreed.version, bytes: null },
		);
	}
	if (head !== null)
		for (const chunk of chunks(
			paths.filter((path) => !remoteNow.has(path)),
			READ_CHUNK,
		)) {
			const got = await remote.readAt(chunk, head, { attachments: false });
			if (got.error !== null) return got;
			for (const file of got.data) remoteNow.set(file.path, file);
		}
	const versionOf = (file: RemoteFile | undefined) =>
		file === undefined || 'gone' in file ? null : file.version;
	const remoteChanged = (path: string) => {
		const agreed = at[path];
		const now = versionOf(remoteNow.get(path));
		if (agreed !== undefined) return now !== agreed.version;
		if (changedRemote === null) return now !== null;
		return changedRemote.has(path);
	};

	const needLocal = paths.filter(
		(path) => localChanged(path) && localNow.has(path),
	);
	const localBytes = new Map<string, { bytes: Uint8Array; version: Version }>();
	for (const chunk of chunks(needLocal, READ_CHUNK)) {
		const got = await local.read(chunk);
		if (got.error !== null) return got;
		for (const file of got.data)
			if (!('gone' in file)) localBytes.set(file.path, file);
	}

	const steps: Step[] = [];
	const toMerge: {
		path: string;
		local: { bytes: Uint8Array; version: Version };
		remote: Exclude<RemoteFile, { gone: true }>;
	}[] = [];
	for (const path of paths) {
		const there = remoteNow.get(path);
		const remoteVersion = versionOf(there);
		const mine = localBytes.get(path);
		const localVersion = mine?.version ?? localNow.get(path) ?? null;
		const settle = (): Step => ({
			kind: 'settle',
			path,
			local: localVersion,
			remote: remoteVersion,
		});
		const theirsChanged = remoteChanged(path);
		const mineChanged = localChanged(path);
		if (!theirsChanged && !mineChanged) {
			steps.push(settle());
			continue;
		}
		const pull = (): Step => ({
			kind: 'pull',
			path,
			local: localNow.get(path) ?? null,
			remote: there ?? { path, gone: true },
		});
		const push = (): Step => ({
			kind: 'push',
			path,
			bytes: mine?.bytes ?? null,
			local: mine?.version ?? null,
			over: remoteVersion ?? 'absent',
		});
		if (!mineChanged) {
			steps.push(pull());
			continue;
		}
		if (!theirsChanged) {
			steps.push(push());
			continue;
		}
		// Both changed. An edit beats a delete; equal bytes agree.
		if (mine === undefined && remoteVersion === null) steps.push(settle());
		else if (mine === undefined) steps.push(pull());
		else if (there === undefined || 'gone' in there) steps.push(push());
		else if (there.bytes !== null && sameBytes(there.bytes, mine.bytes))
			steps.push(settle());
		else if (!isNotePath(path)) steps.push(push());
		else toMerge.push({ path, local: mine, remote: there });
	}

	// Each merge's base, read where its file last agreed.
	const baseAt = new Map<string, string | null>();
	for (const { path } of toMerge) {
		const agreed = at[path];
		baseAt.set(
			path,
			agreed === undefined
				? baseCommit
				: agreed.version === null
					? null
					: agreed.commit,
		);
	}
	const bases = new Map<string, string>();
	const byCommit = new Map<string, string[]>();
	for (const [path, commit] of baseAt)
		if (commit !== null)
			byCommit.set(commit, [...(byCommit.get(commit) ?? []), path]);
	for (const [commit, group] of byCommit)
		for (const chunk of chunks(group, READ_CHUNK)) {
			const got = await remote.readAt(chunk, commit, { attachments: false });
			if (got.error !== null) return got;
			for (const file of got.data)
				if (!('gone' in file) && file.bytes !== null)
					bases.set(file.path, decoder.decode(file.bytes));
		}
	for (const { path, local: mine, remote: theirs } of toMerge) {
		const merged = merge3(
			bases.get(path) ?? null,
			decoder.decode(mine.bytes),
			decoder.decode(theirs.bytes ?? new Uint8Array()),
			{ later: 'current' },
		);
		steps.push({
			kind: 'merge',
			path,
			bytes: encoder.encode(merged.text ?? ''),
			conflict: merged.conflict,
			local: mine.version,
			remote: theirs.version,
		});
	}

	// 3. The local side first, so a write another program makes meanwhile is kept.
	const settled = (
		path: string,
		localVersion: Version | null,
		remoteVersion: Version | null,
	) => {
		if (localVersion === null) delete files[path];
		else files[path] = localVersion;
		at[path] = { commit: head, version: remoteVersion };
	};
	for (const step of steps)
		if (step.kind === 'settle') settled(step.path, step.local, step.remote);

	/** The paths whose write this pass landed, on either side. */
	const landed = new Set<string>();
	/** Save `next`: null when it was saved as it is, else what another sync of this folder saved, with this pass's landings. */
	const save = (next: Manifest) => manifest.save(next, { files, at, landed });

	const kept: string[] = [];
	const pushes: (Step & { kind: 'push' })[] = steps.filter(
		(step): step is Step & { kind: 'push' } => step.kind === 'push',
	);
	for (const step of steps) {
		if (step.kind !== 'merge') continue;
		const written = await local.write(step.path, step.bytes, step.local);
		if (written.error !== null) return written;
		if (written.data === 'stale' || written.data === null) {
			kept.push(step.path);
			continue;
		}
		wrote(step.path, written.data);
		// Merged here, not yet in the repository: changed locally, against the version merged with.
		delete files[step.path];
		at[step.path] = { commit: head, version: step.remote };
		landed.add(step.path);
		report.merged.push(step.path);
		if (step.conflict) report.conflicts.push(step.path);
		pushes.push({
			kind: 'push',
			path: step.path,
			bytes: step.bytes,
			local: written.data,
			over: step.remote,
		});
		const saved = await save({ commit: state.commit, files, at });
		if (saved.error !== null) return saved;
		if (saved.data !== null)
			return Ok({ state: saved.data, done: false, listing: after });
	}

	const pulls = steps.filter(
		(step): step is Step & { kind: 'pull' } => step.kind === 'pull',
	);
	const fetch = pulls
		.filter(({ remote: file }) => !('gone' in file) && file.bytes === null)
		.map(({ path }) => path);
	const fetched = new Map<string, Uint8Array>();
	if (head !== null)
		for (const chunk of chunks(fetch, READ_CHUNK)) {
			const got = await remote.readAt(chunk, head, { attachments: true });
			if (got.error !== null) return got;
			for (const file of got.data)
				if (!('gone' in file) && file.bytes !== null)
					fetched.set(file.path, file.bytes);
		}
	for (const step of pulls) {
		const file = step.remote;
		const bytes =
			'gone' in file ? null : (file.bytes ?? fetched.get(step.path) ?? null);
		if (!('gone' in file) && bytes === null)
			return ClientError.Unavailable({
				cause: `${step.path} could not be read at ${head}`,
			});
		const written = await local.write(step.path, bytes, step.local ?? 'absent');
		if (written.error !== null) return written;
		if (written.data === 'stale') {
			kept.push(step.path);
			continue;
		}
		settled(step.path, written.data, versionOf(file));
		wrote(step.path, written.data);
		landed.add(step.path);
		report.pulled.push(step.path);
	}

	// A file kept keeps its old base: read the version it agreed at.
	if (kept.length > 0) {
		const unknown = kept.filter(
			(path) => state.at?.[path] === undefined && !lost,
		);
		const agreed = new Map<string, Version | null>();
		if (baseCommit !== null && unknown.length > 0) {
			const got = await remote.readAt(unknown, baseCommit, {
				attachments: false,
			});
			if (got.error !== null) return got;
			for (const file of got.data) agreed.set(file.path, versionOf(file));
		}
		for (const path of kept) {
			at[path] = (!lost && state.at?.[path]) || {
				commit: baseCommit,
				version: agreed.get(path) ?? null,
			};
			if (!lost && state.files[path] !== undefined)
				files[path] = state.files[path];
			else delete files[path];
		}
		report.kept.push(...kept);
	}
	if (pulls.length > 0 || kept.length > 0) {
		const saved = await save({ commit: state.commit, files, at });
		if (saved.error !== null) return saved;
		if (saved.data !== null)
			return Ok({ state: saved.data, done: false, listing: after });
	}

	// Then the repository, in batches of one commit each.
	const batches: (Step & { kind: 'push' })[][] = [];
	let batch: (Step & { kind: 'push' })[] = [];
	let size = 0;
	for (const step of pushes) {
		const bytes = step.bytes?.byteLength ?? 0;
		if (
			batch.length > 0 &&
			(batch.length >= WRITE_CHUNK || size + bytes > WRITE_BYTES)
		) {
			batches.push(batch);
			batch = [];
			size = 0;
		}
		batch.push(step);
		size += bytes;
	}
	if (batch.length > 0) batches.push(batch);
	for (const group of batches) {
		const wrote = await writeBatch(remote, group, report);
		if (wrote.error !== null) return wrote;
		if (wrote.data === null) continue;
		if (wrote.data === 'stale') {
			const kept = { commit: state.commit, files, at };
			const saved = await save(kept);
			if (saved.error !== null) return saved;
			return Ok({ state: saved.data ?? kept, done: false, listing: after });
		}
		const { steps: written, receipt } = wrote.data;
		for (const step of written) {
			if (step.local === null) delete files[step.path];
			else files[step.path] = step.local;
			at[step.path] = {
				commit: receipt.commit,
				version: receipt.versions[step.path] ?? null,
			};
			landed.add(step.path);
			report.pushed.push(step.path);
		}
	}

	// 4. Agreed at the commit read: a file agreed there needs no entry of its own.
	const elsewhere = Object.fromEntries(
		Object.entries(at).filter(([, base]) => base.commit !== head),
	);
	const next: Manifest =
		Object.keys(elsewhere).length === 0
			? { commit: head, files }
			: { commit: head, files, at: elsewhere };
	if (JSON.stringify(next) === JSON.stringify(state))
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
 * Write `steps` to the repository in one commit, leaving out every path it
 * refuses, which `report` names: the steps that landed with the receipt,
 * `'stale'` when a path moved, or null when every path was refused.
 */
async function writeBatch(
	remote: Repository,
	steps: (Step & { kind: 'push' })[],
	report: SyncReport,
): Promise<
	Result<
		| { steps: (Step & { kind: 'push' })[]; receipt: BatchReceipt }
		| 'stale'
		| null,
		Unavailable
	>
> {
	let writing = steps;
	while (writing.length > 0) {
		const landed = await remote.writeAll(
			writing.map(({ path, bytes, over }) => ({ path, bytes, over })),
		);
		if (landed.error !== null) return landed;
		if (landed.data === 'stale') return Ok('stale');
		if (!('refused' in landed.data))
			return Ok({ steps: writing, receipt: landed.data });
		// A path the repository will never take: report it, and write the rest.
		const { refused, reason } = landed.data;
		const out = writing.filter(({ path }) => within(path, [refused]));
		if (out.length === 0)
			return ClientError.Unavailable({
				cause: `the repository refused ${refused}, which this sync did not write: ${reason}`,
			});
		for (const { path } of out) report.refused.push({ path, reason });
		writing = writing.filter((step) => !out.includes(step));
	}
	return Ok(null);
}
