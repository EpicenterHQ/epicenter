/**
 * What a computer remembers it synced (ADR-0821, ADR-0822): one record per
 * synced folder at the Epicenter folder's root,
 * `.epicenter/synced/<folder-id>.json`, holding `{ folder, name, inode,
 * birthtime, cursor, files }`: the folder's id on the server, the name and
 * identity of the directory that agreed it, and what was agreed. Named by
 * folder id, so one directory at most syncs a server folder here. Only
 * Epicenter's programs (the CLI, `epicenter mcp`, and the Epicenter app)
 * write them, and every write is over the version read, as a sync's
 * manifest save is (`storeManifest`, below).
 *
 * Beside them are the hash caches, `.epicenter/hashes/<identity>.json`,
 * named by the directory's identity rather than a folder id, so a folder
 * never synced is cached too.
 */
import { ClientError } from '@epicenter/definition/contract';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { StampFile } from '../device/stamp-cache.js';
import {
	putLanded,
	type Store,
	type Unavailable,
	type Version,
} from '../device/store.js';
import { type FolderIdentity, identityKey } from '../identity.js';
import { HASHES, RECORDS } from '../state.js';

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
type ManifestVersion = Version | null;

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
const emptyManifest = (): Manifest => ({ cursor: null, files: {} });

/**
 * The manifest kept at `path` in `store`, read and written as any file
 * there: a folder's record in the Epicenter folder's `.epicenter`
 * (`synced/<folder-id>.json`). One that is gone reads as never synced.
 */
function storeManifest(store: Store, path: string): ManifestStore {
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

/** A folder's record on this computer. */
export type FolderRecord = Manifest & {
	/** The folder's id on the server. */
	folder: string;
	/** The name of the directory that agreed it, in the Epicenter folder. */
	name: string;
	/** That directory's identity when it agreed (`FolderIdentity`). */
	inode: string;
	birthtime: string | null;
};

/** A record as read, with the version the next write of it goes over. */
export type HeldRecord = { record: FolderRecord; version: Version };

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Where the record of `folder` is, in the Epicenter folder's `.epicenter`. */
export const recordPath = (folder: string) => `${RECORDS}/${folder}.json`;

/** Where the hash cache of the directory `identity` names is. */
export const hashesPath = (identity: FolderIdentity) =>
	`${HASHES}/${identityKey(identity)}.json`;

const isRecord = (value: unknown): value is FolderRecord => {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.folder === 'string' &&
		typeof record.name === 'string' &&
		typeof record.inode === 'string' &&
		(record.birthtime === null || typeof record.birthtime === 'string') &&
		(record.cursor === null || typeof record.cursor === 'string') &&
		typeof record.files === 'object' &&
		record.files !== null
	);
};

/** The records in `store` (the Epicenter folder's `.epicenter`). */
export function recordsIn(store: Store) {
	return {
		store,
		/** Every record that reads; one that does not is left out. */
		async list(): Promise<Result<HeldRecord[], Unavailable>> {
			const listed = await store.list([RECORDS]);
			if (listed.error !== null) return listed;
			const paths = listed.data
				.map(({ path }) => path)
				.filter((path) => /^synced\/[^/]+\.json$/.test(path));
			const read = await store.read(paths);
			if (read.error !== null) return read;
			const held: HeldRecord[] = [];
			for (const file of read.data) {
				if ('gone' in file) continue;
				try {
					const record: unknown = JSON.parse(decoder.decode(file.bytes));
					if (isRecord(record) && file.path === recordPath(record.folder))
						held.push({ record, version: file.version });
				} catch {
					// A record that does not read is no record.
				}
			}
			return Ok(
				held.sort((a, b) => (a.record.folder < b.record.folder ? -1 : 1)),
			);
		},
		/**
		 * Write `record` while its file holds `expect` (null: none): the
		 * version landed, or `'moved'` when another program wrote it first.
		 */
		async write(
			record: FolderRecord,
			expect: Version | null,
		): Promise<Result<Version | 'moved', Unavailable>> {
			const written = await putLanded(
				store,
				recordPath(record.folder),
				encoder.encode(JSON.stringify(record)),
				expect,
			);
			if (written.error?.name === 'Moved') return Ok('moved' as const);
			if (written.error !== null) return { data: null, error: written.error };
			if (written.data === null)
				return ClientError.Unavailable({
					cause: `the record of ${record.folder} landed nothing`,
				});
			return Ok(written.data);
		},
		/** The record of `folder` as the manifest a sync reads and saves. */
		manifest(folder: string): ManifestStore {
			return storeManifest(store, recordPath(folder));
		},
		/** The hash cache of the directory `identity` names. */
		hashes(identity: FolderIdentity): StampFile {
			return storeStampFile(store, hashesPath(identity));
		},
	};
}

export type Records = ReturnType<typeof recordsIn>;

/**
 * A hash cache kept at `path` in `store`: loaded once, and saved over
 * whatever is there, since a cache two programs race on costs only a hash.
 */
export function storeStampFile(store: Store, path: string): StampFile {
	return {
		async load() {
			const read = await store.read([path]);
			const [file] = read.data ?? [];
			return file === undefined || 'gone' in file ? null : file.bytes;
		},
		async save(bytes) {
			for (let tries = 0; tries < 3; tries++) {
				const read = await store.read([path]);
				if (read.error !== null) return;
				const [file] = read.data;
				const expect =
					file === undefined || 'gone' in file ? null : file.version;
				const written = await store.put(path, bytes, expect);
				if (written.error?.name !== 'Moved') return;
			}
		},
	};
}
