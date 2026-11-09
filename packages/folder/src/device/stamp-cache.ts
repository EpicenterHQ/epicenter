/**
 * A computer's cache of its large files' versions, by stamp (ADR-0824): a
 * version is the SHA-256 of a file's bytes, and a listing must not read a
 * long recording to name it. So a device remembers the version of each file
 * over `HASHED_WHOLE_BYTES` under its stamp (size, modification time, and
 * identity), in a file outside the folder (ADR-0822): the Epicenter
 * folder's `.epicenter/hashes/<identity>.json`, or an app's own data. The
 * cache is derived and deletable: without it, each large file is hashed
 * once again. Smaller files are never cached: they are hashed whole.
 *
 * Git's racy-clean rule keeps a stamp honest. A file written within the
 * second its hash was taken could change again with the same stamp, so an
 * entry holds only for a file whose modification time is in an earlier
 * second than the hash; anything else is hashed again.
 */
import type { Version } from './store.js';

/** Where a cache is kept: its bytes, loaded once, and saved whole. */
export type StampFile = {
	load(): Promise<Uint8Array | null>;
	save(bytes: Uint8Array): Promise<void>;
};

/** One file's version as cached: under which stamp, and when it was hashed (ms). */
type Entry = { stamp: string; version: string; hashed: number };

/** What a host gives the cache: its stamp of a file, and the file's modification time. */
export type Stamped = {
	/** The file's stamp, which every save changes. */
	stamp: string;
	/** Its modification time, in milliseconds. */
	modifiedMs: number;
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * The cache kept in `file` (read once, at the first lookup), answering
 * files' versions: from an entry that still holds, or by `hash`. `flush`
 * saves what changed; a cache that cannot be read or saved costs hashing
 * again, never a wrong version.
 */
export function createStampCache({
	file,
	now = Date.now,
}: {
	file: StampFile;
	now?: () => number;
}) {
	let entries: Map<string, Entry> | null = null;
	let dirty = false;

	async function loaded() {
		if (entries !== null) return entries;
		const next = new Map<string, Entry>();
		try {
			const bytes = await file.load();
			if (bytes !== null) {
				const parsed: unknown = JSON.parse(decoder.decode(bytes));
				if (typeof parsed === 'object' && parsed !== null)
					for (const [path, entry] of Object.entries(parsed))
						if (isEntry(entry)) next.set(path, entry);
			}
		} catch {
			// An unreadable cache is an empty one.
		}
		entries ??= next;
		return entries;
	}

	return {
		/**
		 * The version of the file at `path`, stamped `stamped`: its cached
		 * version when the entry holds, else `hash()`, remembered.
		 */
		async version(
			path: string,
			stamped: Stamped,
			hash: () => Promise<Version>,
		): Promise<Version> {
			const cache = await loaded();
			const entry = cache.get(path);
			if (
				entry !== undefined &&
				entry.stamp === stamped.stamp &&
				Math.floor(stamped.modifiedMs / 1000) < Math.floor(entry.hashed / 1000)
			)
				return entry.version as Version;
			const hashed = now();
			const version = await hash();
			cache.set(path, { stamp: stamped.stamp, version, hashed });
			dirty = true;
			return version;
		},
		/** Forget every path not in `kept`, after a listing of everything. */
		async keepOnly(kept: ReadonlySet<string>) {
			const cache = await loaded();
			for (const path of cache.keys())
				if (!kept.has(path)) {
					cache.delete(path);
					dirty = true;
				}
		},
		/** Save the cache when it changed. */
		async flush() {
			if (!dirty || entries === null) return;
			dirty = false;
			try {
				await file.save(
					encoder.encode(JSON.stringify(Object.fromEntries(entries))),
				);
			} catch {
				// The next listing hashes again what this one could not save.
			}
		},
	};
}

export type StampCache = ReturnType<typeof createStampCache>;

const isEntry = (value: unknown): value is Entry =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as Entry).stamp === 'string' &&
	typeof (value as Entry).version === 'string' &&
	/^[0-9a-f]{64}$/.test((value as Entry).version) &&
	typeof (value as Entry).hashed === 'number';
