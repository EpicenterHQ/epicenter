/**
 * What a computer remembers it synced (ADR-0821, ADR-0822): one record per
 * synced folder at the Epicenter folder's root,
 * `.epicenter/synced/<folder-id>.json`, holding `{ folder, name, inode,
 * birthtime, cursor, files }`: the folder's id on the server, the name and
 * identity of the directory that agreed it, and what was agreed. Named by
 * folder id, so one directory at most syncs a server folder here. Only
 * Epicenter's programs (the CLI, `epicenter mcp`, and the Epicenter app)
 * write them, and every write is over the version read, as a sync's
 * manifest save is (`storeManifest`).
 *
 * Beside them are the hash caches, `.epicenter/hashes/<identity>.json`,
 * named by the directory's identity rather than a folder id, so a folder
 * never synced is cached too.
 */
import { ClientError } from '@epicenter/definition/contract';
import { Ok, type Result } from 'wellcrafted/result';
import type { StampFile } from '../device/stamp-cache.js';
import {
	putLanded,
	type Store,
	type Unavailable,
	type Version,
} from '../device/store.js';
import { type FolderIdentity, identityKey } from '../identity.js';
import { HASHES, RECORDS } from '../state.js';
import {
	type Manifest,
	type ManifestStore,
	storeManifest,
} from '../sync/sync.js';

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
