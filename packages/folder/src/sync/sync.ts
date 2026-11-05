/**
 * Sync is a function of two stores and a manifest (ADR-0803):
 * `sync({ local, remote, manifest })`. `local` is any store (a folder's
 * directory, the web's memory); `remote` is a repository, a store with
 * history (`repository.ts`). No Git runs on this side.
 *
 * The manifest is the last state both sides agreed on: the repository's
 * `commit`, and each file's local `version`. A file this computer wrote to
 * the repository after that commit, or settled at a later one, records the
 * commit and version it agreed at in `at`, its base until the next sync
 * moves `commit` past it. One sync:
 *
 * 1. Asks the repository what changed since `commit` (everything on first
 *    contact), lists the local store, and compares each with the manifest.
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
 * 4. Moves the manifest to the commit it read at.
 *
 * The manifest is saved after the local writes (and after each merge
 * written there) and at the end, so a sync stopped anywhere reruns from
 * what landed: a merged note written locally merges next time against the
 * repository's version it already holds, never twice into markers.
 */
import {
	ClientError,
	isHiddenPath,
	isNotePath,
} from '@epicenter/definition/contract';
import { merge3 } from '@epicenter/definition/front-matter';
import { Ok, type Result } from 'wellcrafted/result';
import type { Store, Unavailable, Version } from '../device/store.js';
import type { BatchWrite, RemoteFile, Repository } from './repository.js';

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

/** Where a manifest is kept between syncs. */
export type ManifestStore = {
	read(): Promise<Result<Manifest, Unavailable>>;
	write(manifest: Manifest): Promise<Result<void, Unavailable>>;
};

/** The manifest of a store never synced. */
export const emptyManifest = (): Manifest => ({ commit: null, files: {} });

/** Where a folder keeps its manifest, beside its files (ADR-0803). */
export const MANIFEST_PATH = '.epicenter/synced.json';

/** A manifest held in memory, for a test or the web's memory store. */
export function memoryManifest(initial: Manifest = emptyManifest()) {
	let current = structuredClone(initial);
	return {
		async read() {
			return Ok(structuredClone(current));
		},
		async write(manifest: Manifest) {
			current = structuredClone(manifest);
			return Ok(undefined);
		},
		/** The manifest as last written. */
		current: () => structuredClone(current),
	} satisfies ManifestStore & { current(): Manifest };
}

/**
 * The manifest kept at `MANIFEST_PATH` in `store`, written over the
 * version last read: a second sync of one folder running at once finds it
 * `Unavailable` rather than overwriting the first's.
 */
export function storeManifest(store: Store): ManifestStore {
	let version: Version | 'absent' = 'absent';
	return {
		async read() {
			const read = await store.read([MANIFEST_PATH]);
			if (read.error !== null) return read;
			const [file] = read.data;
			if (file === undefined || 'gone' in file) {
				version = 'absent';
				return Ok(emptyManifest());
			}
			version = file.version;
			try {
				return Ok(JSON.parse(new TextDecoder().decode(file.bytes)) as Manifest);
			} catch (cause) {
				return ClientError.Unavailable({ cause });
			}
		},
		async write(manifest) {
			const bytes = new TextEncoder().encode(JSON.stringify(manifest));
			const written = await store.write(MANIFEST_PATH, bytes, version);
			if (written.error !== null) return written;
			if (written.data === 'stale' || written.data === null)
				return ClientError.Unavailable({
					cause: `${MANIFEST_PATH} changed during the sync: another sync of this folder is running`,
				});
			version = written.data;
			return Ok(undefined);
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
	let state = read.data;
	const report: SyncReport = {
		outcome: 'retry',
		passes: 0,
		pulled: [],
		pushed: [],
		merged: [],
		conflicts: [],
		kept: [],
	};
	while (report.passes < passes) {
		report.passes++;
		const ran = await syncPass({ local, remote, manifest, state, report });
		if (ran.error !== null) return ran;
		state = ran.data.state;
		if (ran.data.done) {
			report.outcome = 'synced';
			break;
		}
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
	});
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
}: {
	local: Store;
	remote: Repository;
	manifest: ManifestStore;
	state: Manifest;
	report: SyncReport;
}): Promise<Result<{ state: Manifest; done: boolean }, Unavailable>> {
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

	const listed = await local.list(['']);
	if (listed.error !== null) return listed;
	const localNow = new Map(
		listed.data
			.filter(({ path }) => !isHiddenPath(path))
			.map(({ path, version }) => [path, version]),
	);

	const candidates = new Set<string>([
		...(changedRemote ?? everyRemote),
		...Object.keys(at),
	]);
	for (const [path, version] of localNow)
		if (files[path] !== version) candidates.add(path);
	for (const path of Object.keys(files))
		if (!localNow.has(path)) candidates.add(path);
	const paths = [...candidates].filter((path) => !isHiddenPath(path)).sort();

	// 2. Each candidate as the repository holds it now, and as it was agreed.
	const remoteNow = new Map<string, RemoteFile>();
	if (head !== null)
		for (const chunk of chunks(paths, READ_CHUNK)) {
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
	const localChanged = (path: string) =>
		(localNow.get(path) ?? null) !== (files[path] ?? null);

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
		// Merged here, not yet in the repository: changed locally, against the version merged with.
		delete files[step.path];
		at[step.path] = { commit: head, version: step.remote };
		report.merged.push(step.path);
		if (step.conflict) report.conflicts.push(step.path);
		pushes.push({
			kind: 'push',
			path: step.path,
			bytes: step.bytes,
			local: written.data,
			over: step.remote,
		});
		const saved = await manifest.write({ commit: state.commit, files, at });
		if (saved.error !== null) return saved;
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
		const saved = await manifest.write({ commit: state.commit, files, at });
		if (saved.error !== null) return saved;
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
		const writes: BatchWrite[] = group.map(({ path, bytes, over }) => ({
			path,
			bytes,
			over,
		}));
		const landed = await remote.writeAll(writes);
		if (landed.error !== null) return landed;
		if (landed.data === 'stale') {
			const saved = await manifest.write({ commit: state.commit, files, at });
			if (saved.error !== null) return saved;
			return Ok({ state: { commit: state.commit, files, at }, done: false });
		}
		for (const step of group) {
			if (step.local === null) delete files[step.path];
			else files[step.path] = step.local;
			at[step.path] = {
				commit: landed.data.commit,
				version: landed.data.versions[step.path] ?? null,
			};
			report.pushed.push(step.path);
		}
	}

	// 4. Agreed at the commit read: a file agreed there needs no entry of its own.
	for (const [path, base] of Object.entries(at))
		if (base.commit === head) delete at[path];
	const next: Manifest =
		Object.keys(at).length === 0
			? { commit: head, files }
			: { commit: head, files, at };
	if (JSON.stringify(next) !== JSON.stringify(state)) {
		const written = await manifest.write(next);
		if (written.error !== null) return written;
	}
	return Ok({ state: next, done: true });
}
