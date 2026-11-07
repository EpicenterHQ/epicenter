/**
 * Sync is a function of two stores and a manifest (ADR-0803):
 * `sync({ local, remote, manifest })`. `local` is any store (a folder's
 * directory, the open folder, the web's memory); `remote` is a folder's
 * log on the server (`repository.ts`): what changed since a cursor with
 * each path's version, every file, bytes by version, and appending a change. No Git
 * runs on this side.
 *
 * A file's version is the SHA-256 of its bytes on every store (ADR-0824),
 * so the manifest is `{ cursor, files }`: the point of the folder's log
 * both sides last agreed at, and each file's agreed version. On a computer
 * it is the folder's record at the Epicenter folder's root (ADR-0822),
 * which adds the folder's id and the directory's name and identity, carried
 * through every save. A side changed a file when its version differs from
 * the agreed one, and a note both sides changed merges against the agreed
 * version, read by it. One sync runs passes:
 *
 * 1. Lists the local store, then asks the server what changed since
 *    `cursor`, each path with its version now (every file when the manifest
 *    names no cursor, or one the log does not answer), and takes as candidates
 *    the paths changed on either side, with every path this sync appended
 *    earlier. A candidate the server did not name holds its agreed version
 *    there, since nothing changed it since the cursor.
 * 2. Copies a file changed on one side to the other. A note changed on
 *    both merges by `merge3` against its agreed version; this computer's side
 *    is the later write. An attachment changed on both takes this
 *    computer's; an edit beats a delete; equal versions agree.
 * 3. Writes the local side first, each file over the version listed, so a
 *    file another program wrote meanwhile is `Moved` and kept for the next
 *    sync to merge. Then it appends to the server in batches, each over
 *    the versions read. A moved batch lands nothing: the sync lists again
 *    and runs another pass.
 * 4. A pass that appended is followed by one more, which reads again every
 *    path this sync appended and takes what others landed meanwhile; a
 *    pass that appended nothing agrees at the head it read, and the
 *    manifest moves there, unless a file it kept for the next sync changed
 *    on the server: then the cursor stays, so the next sync hears it again.
 *
 * A sync that would delete many files on the server stops before it writes
 * anything and asks (`outcome: 'deletions'`, ADR-0821): an older backup
 * restored in place, a folder emptied, or an app making an empty folder at
 * the old path all look like that. `deletions: 'push'` sends them, and
 * `'restore'` brings them back from the server instead (`tooManyDeletions`
 * says how many is many).
 *
 * The manifest is saved after the local writes (and after each merge
 * written there) and at the end, so a sync stopped anywhere reruns from
 * what landed: a merged note written locally is agreed at the server's
 * version it merged with, so it merges next time against that, never twice
 * into markers. Every save but the last names no cursor: its files agree
 * at more than one point, so the next sync compares every path by version
 * rather than trusting what changed since one.
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
	putLanded,
	type Store,
	type Unavailable,
	type Version,
	within,
} from '../device/store.js';
import type { ChangeReceipt, Repository } from './repository.js';

/**
 * Which folder on the server a folder syncs with: its id, which the server
 * mints when it makes it. The one place a manifest names it; `folderUrl`
 * (`@epicenter/definition/site`) is the one place that becomes an address.
 */
export type RepositoryAddress = { folder: string };

/**
 * What a sync agreed (ADR-0804, ADR-0824). A record on a computer carries
 * more fields (`FolderRecord`), which every save keeps as they are.
 */
export type Manifest = {
	/** The point of the folder's log both sides last agreed at; null before the first sync, or after one that stopped. */
	cursor: string | null;
	/** Each synced file's agreed version: the SHA-256 of its bytes, the same on both sides. */
	files: Record<string, Version>;
};

/** The version of a saved manifest, which the next save is written over; null before the first. */
export type ManifestVersion = Version | null;

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
	): Promise<Result<Version | 'moved', Unavailable>>;
};

/** The manifest of a store never synced. */
export const emptyManifest = (): Manifest => ({ cursor: null, files: {} });

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
			version = `saved-${++saves}` as Version;
			return Ok(version);
		},
		/** The manifest as last written. */
		current: () => structuredClone(current),
	} satisfies ManifestStore & { current(): Manifest };
}

/**
 * The manifest kept at `path` in `store`, read and written as any file
 * there: a folder's record in the Epicenter folder's `.epicenter`
 * (`synced/<folder-id>.json`). One that is gone reads as never synced.
 */
export function storeManifest(store: Store, path: string): ManifestStore {
	return {
		async read() {
			const read = await store.read([path]);
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
			const written = await putLanded(store, path, bytes, expect);
			if (written.error?.name === 'Moved') return Ok('moved' as const);
			if (written.error !== null) return Err(written.error);
			if (written.data === null)
				return ClientError.Unavailable({
					cause: `the write of ${path} landed nothing`,
				});
			return Ok(written.data);
		},
	};
}

/**
 * What one sync did. `retry` when the server kept moving under it for
 * every pass; `deletions` when it stopped before writing anything, because
 * it would delete many files on the server (`deletions` names them).
 */
export type SyncReport = {
	outcome: 'synced' | 'retry' | 'deletions';
	passes: number;
	/** Files copied from the server to the local store. */
	pulled: string[];
	/** Files written to the server. */
	pushed: string[];
	/** Notes changed on both sides and merged. */
	merged: string[];
	/** Merged notes whose body holds Git's conflict markers. */
	conflicts: string[];
	/** Files another program wrote locally during the sync: kept, and merged by the next one. */
	kept: string[];
	/**
	 * Files the server refused, and why: a path that differs only in
	 * case from one it holds. Kept here, and refused again by every sync
	 * until a person renames one.
	 */
	refused: { path: string; reason: string }[];
	/** The files deleted here that it would delete on the server, when it stopped to ask (`outcome: 'deletions'`). */
	deletions: string[];
};

/**
 * What a sync does with files deleted here that the server still holds as
 * agreed: `ask` stops before writing anything when they are many
 * (`tooManyDeletions`), `push` deletes them on the server, and `restore`
 * brings them back here from the server.
 */
export type Deletions = 'ask' | 'push' | 'restore';

/**
 * Whether deleting `count` files of a folder that agreed on `agreed` files
 * is many enough to ask first: 20 or more, or 5 or more that are half the
 * folder or more. Epicenter syncs seconds after a change, so a person
 * deleting by hand rarely deletes 20 files between two syncs, and a folder
 * emptied or rolled back by a backup usually does; the share catches a
 * small folder emptied, which never reaches 20.
 */
export function tooManyDeletions(count: number, agreed: number): boolean {
	return count >= 20 || (count >= 5 && count * 2 >= agreed);
}

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
 * whose append found the server moved lists again.
 */
export async function sync({
	local,
	remote,
	manifest,
	passes = 4,
	deletions = 'ask',
}: {
	local: Store;
	remote: Repository;
	manifest: ManifestStore;
	passes?: number;
	/** What to do with files deleted here (`Deletions`); `ask` by default. */
	deletions?: Deletions;
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
		deletions: [],
	};
	/** Every path this sync appended: each later pass reads it again at the head. */
	const appended = new Set<string>();
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
			appended,
			deletions,
		});
		if (ran.error !== null) return ran;
		if (ran.data === 'deletions') {
			report.outcome = 'deletions';
			break;
		}
		state = ran.data.state;
		report.outcome = ran.data.done ? 'synced' : 'retry';
		if (ran.data.done && report.pushed.length === pushedBefore) break;
		// A pass that pushed is followed by one that agrees at the head,
		// taking what others landed meanwhile. Only the server moved: it
		// reuses this listing. A pass whose append found it moved lists again.
		listing = ran.data.done ? ran.data.listing : null;
	}
	// A file a moved pass handled is handled again by the next: name it once.
	const once = (paths: string[]) => [...new Set(paths)];
	return Ok({
		...report,
		deletions: once(report.deletions),
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
	files: Record<string, Version>;
	landed: ReadonlySet<string>;
};

/**
 * The manifest as one sync saves it: over the version it last read or
 * saved. When another sync of the folder saved first, it reads that one,
 * lays over it, path by path, the files whose write this sync landed, and
 * saves that with no cursor, since its files now agree at more than one point:
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
				cause:
					'the manifest kept changing: other syncs of this folder are running',
			});
		},
	};
}

/** `theirs`, with the file of each path in `landed` taken from this sync's, agreed at no one point. */
function overlay(theirs: Manifest, { files, landed }: Landings): Manifest {
	const next = { ...theirs.files };
	for (const path of landed) {
		const version = files[path];
		if (version === undefined) delete next[path];
		else next[path] = version;
	}
	return { ...theirs, cursor: null, files: next };
}

/** A change for the server: a file's bytes, or null to delete it, where the path holds `expect`. */
type Push = {
	path: string;
	bytes: Uint8Array | null;
	/** The local version written: the manifest agrees at it once it lands. */
	local: Version | null;
	expect: Version | null;
};

async function syncPass({
	local,
	remote,
	manifest,
	state,
	report,
	listing,
	appended,
	deletions,
}: {
	local: Store;
	remote: Repository;
	manifest: ReturnType<typeof savedManifest>;
	state: Manifest;
	report: SyncReport;
	/** The local store's visible files and versions, when the last pass's still hold; null to list them. */
	listing: Map<string, Version> | null;
	/** Every path this sync appended, which this pass reads again. */
	appended: Set<string>;
	deletions: Deletions;
}): Promise<
	Result<
		| { state: Manifest; done: boolean; listing: Map<string, Version> }
		| 'deletions',
		Unavailable
	>
> {
	// 1. Where each side is: this side first, so the server is read no
	// earlier than the listing. A merge another sync of this folder wrote
	// here after the server was read would otherwise look like a change of
	// this computer's, and merge into its own markers.
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
	const since = await remote.changes(state.cursor);
	if (since.error !== null) return since;
	let head = since.data.cursor;
	const everything = since.data.changes === null;
	const files: Record<string, Version> = { ...state.files };
	/** The version the server holds at each path it named (null: nothing there). */
	const theirs = new Map<string, Version | null>();
	if (since.data.changes === null) {
		const all = await remote.files();
		if (all.error !== null) return all;
		head = all.data.cursor;
		for (const { path, version } of all.data.files) theirs.set(path, version);
	} else
		for (const { path, version } of since.data.changes)
			theirs.set(path, version);
	/** What this pass found locally, then each version its own writes landed: the listing the next pass may reuse. */
	const after = new Map(mine);
	const wroteLocally = (path: string, version: Version | null) => {
		if (version === null) after.delete(path);
		else after.set(path, version);
	};

	const candidates = new Set<string>([...theirs.keys(), ...appended]);
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

	// 2. Each candidate as the server holds it: the version it named, or,
	// for a path it did not name, the version agreed at the cursor.
	const agreed = (path: string) => files[path] ?? null;
	const serverHolds = (path: string) =>
		everything || theirs.has(path) ? (theirs.get(path) ?? null) : agreed(path);
	/** Agree at what both sides hold: the manifest's file becomes it. */
	const settle = (path: string, version: Version | null) => {
		if (version === null) delete files[path];
		else files[path] = version;
	};

	const pulls: {
		path: string;
		local: Version | null;
		remote: Version | null;
	}[] = [];
	const toPush: { path: string; expect: Version | null }[] = [];
	const toMerge: { path: string; remote: Version }[] = [];
	for (const path of paths) {
		const ours = mine.get(path) ?? null;
		const there = serverHolds(path);
		if (ours === there) {
			settle(path, ours);
			continue;
		}
		const theirsChanged = there !== agreed(path);
		const oursChanged = ours !== agreed(path);
		// A file deleted here that the server holds as agreed comes back
		// when the person chose to keep what the server has.
		const restored = ours === null && !theirsChanged && deletions === 'restore';
		// One side changed; when both did, an edit beats a delete, a note
		// merges, and any other file takes this computer's.
		if (!oursChanged || (theirsChanged && ours === null) || restored)
			pulls.push({ path, local: ours, remote: there });
		else if (!theirsChanged || there === null || !isNotePath(path))
			toPush.push({ path, expect: there });
		else toMerge.push({ path, remote: there });
	}
	// Many deletions stop the sync before it writes anything, until a
	// person says what they are.
	if (deletions === 'ask') {
		const deleting = toPush
			.filter(({ path, expect }) => expect !== null && !mine.has(path))
			.map(({ path }) => path);
		if (tooManyDeletions(deleting.length, Object.keys(files).length)) {
			report.deletions = deleting;
			return Ok('deletions');
		}
	}

	// The local bytes of each push and merge.
	const needLocal = [
		...toPush.filter(({ path }) => mine.has(path)).map(({ path }) => path),
		...toMerge.map(({ path }) => path),
	];
	const ourBytes = new Map<string, { bytes: Uint8Array; version: Version }>();
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

	// Each merge: theirs now, against the agreed version, both read by version.
	const wanted = toMerge.flatMap(({ path, remote: version }) => {
		const base = agreed(path);
		return [version, ...(base === null ? [] : [base])];
	});
	const read = new Map<Version, Uint8Array>();
	for (const chunk of chunks(wanted, READ_CHUNK)) {
		const got = await remote.blobs(chunk);
		if (got.error !== null) return got;
		chunk.forEach((version, index) => {
			const bytes = got.data[index];
			if (bytes != null) read.set(version, bytes);
		});
	}
	/** Files another program wrote locally during this pass: kept, and merged by the next sync. */
	const kept: string[] = [];
	const merges: (Push & { bytes: Uint8Array; conflict: boolean })[] = [];
	for (const { path, remote: version } of toMerge) {
		const ours = ourBytes.get(path);
		const theirBytes = read.get(version);
		if (theirBytes === undefined)
			return ClientError.Unavailable({
				cause: `${path} could not be read at ${head}`,
			});
		// Gone since it was listed: the next sync takes it up.
		if (ours === undefined) continue;
		// Written again since it was listed, perhaps by another sync's merge:
		// what to merge was decided from the listing, so the next sync merges
		// what is there then.
		if (ours.version !== mine.get(path)) {
			kept.push(path);
			continue;
		}
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
			expect: version,
		});
	}

	// 3. The local side first, so a write another program makes meanwhile is kept.
	/** The paths whose write this pass landed, on either side. */
	const landed = new Set<string>();
	/** Save `next`: null when it was saved as it is, else what another sync of this folder saved, with this pass's landings. */
	const save = (next: Manifest) => manifest.save(next, { files, landed });
	/** The manifest as it stands mid-sync: agreed at no one point. */
	const midway = (): Manifest => ({ ...state, cursor: null, files });
	/**
	 * The state the next pass starts from: candidates it reads again make it
	 * agree at this head. A file kept for the next sync changed on the
	 * server past the cursor this pass started from, so while one waits the
	 * cursor stays there, and the next sync hears it again.
	 */
	const carried = (): Manifest => ({
		...state,
		cursor: report.kept.length > 0 ? state.cursor : head,
		files,
	});

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
		// Merged here, not yet on the server: agreed at the version merged with.
		files[merge.path] = merge.expect as Version;
		landed.add(merge.path);
		report.merged.push(merge.path);
		if (merge.conflict) report.conflicts.push(merge.path);
		pushes.push({ ...merge, local: written.data });
		const saved = await save(midway());
		if (saved.error !== null) return saved;
		if (saved.data !== null)
			return Ok({ state: saved.data, done: false, listing: after });
	}

	const fetch = pulls.flatMap(({ path, remote: version }) =>
		version === null ? [] : [{ path, version }],
	);
	const fetched = new Map<string, Uint8Array>();
	for (const chunk of chunks(fetch, READ_CHUNK)) {
		const got = await remote.blobs(chunk.map(({ version }) => version));
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

	// Then the server, in batches of one change each.
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
		const landedBatch = await appendBatch(remote, group, report);
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
			appended.add(push.path);
			landed.add(push.path);
			report.pushed.push(push.path);
		}
	}

	// 4. A pass that appended is agreed by the next; one that did not agrees at the head it read.
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
 * Append `pushes` to the server, leaving out every path it refuses,
 * which `report` names: the pushes that landed with the receipt, `'moved'`
 * when a path moved, or null when every path was refused.
 */
async function appendBatch(
	remote: Repository,
	pushes: Push[],
	report: SyncReport,
): Promise<
	Result<
		{ pushes: Push[]; receipt: ChangeReceipt } | 'moved' | null,
		Unavailable
	>
> {
	let writing = pushes;
	while (writing.length > 0) {
		const landed = await remote.append(
			writing.map(({ path, bytes, expect }) => ({ path, bytes, expect })),
		);
		if (landed.error !== null) return landed;
		if ('moved' in landed.data) return Ok('moved');
		if (!('refused' in landed.data))
			return Ok({ pushes: writing, receipt: landed.data });
		// A path the server will never take: report it, and write the rest.
		const { refused, reason } = landed.data;
		const out = writing.filter(({ path }) => within(path, [refused]));
		if (out.length === 0)
			return ClientError.Unavailable({
				cause: `the server refused ${refused}, which this sync did not write: ${reason}`,
			});
		for (const { path } of out) report.refused.push({ path, reason });
		writing = writing.filter((push) => !out.includes(push));
	}
	return Ok(null);
}
