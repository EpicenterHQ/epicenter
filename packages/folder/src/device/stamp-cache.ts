/**
 * A computer's cache of its attachments' hashes, by stamp (ADR-0808): an
 * attachment's version is the blob id of its Git LFS pointer, which needs
 * its sha256, and a listing must not read a long recording to name it. So
 * a device remembers each attachment's sha256 and size under its stamp
 * (size, modification time, and identity), in `.epicenter/hashes.json`.
 * The cache is derived and deletable: without it, each attachment is
 * hashed once again. Notes are never cached: they are small and read
 * whole anyway.
 *
 * Git's racy-clean rule keeps a stamp honest. A file written within the
 * second its hash was taken could change again with the same stamp, so an
 * entry holds only for a file whose modification time is in an earlier
 * second than the hash; anything else is hashed again.
 */
import type { BlobId } from './store.js';
import { pointerBlobId } from '../hash.js';

/** Where the cache lives, beside a folder's unfinished writes. */
export const HASHES_PATH = '.epicenter/hashes.json';

/** One attachment's hash as cached: under which stamp, its sha256 and size, and when it was hashed (ms). */
type Entry = { stamp: string; oid: string; size: number; hashed: number };

/** What a host gives the cache: its stamp of a file, and the file's hash when the cache cannot answer. */
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
 * attachments' versions: from an entry that still holds, or by `hash`.
 * `flush` saves what changed; a cache that cannot be read or saved costs
 * hashing again, never a wrong version.
 */
export function createStampCache({
	file,
	now = Date.now,
}: {
	file: {
		load(): Promise<Uint8Array | null>;
		save(bytes: Uint8Array): Promise<void>;
	};
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
		 * The version of the attachment at `path`, stamped `stamped`: its
		 * cached hash when the entry holds, else `hash()`, remembered.
		 */
		async version(
			path: string,
			stamped: Stamped,
			hash: () => Promise<{ oid: string; size: number }>,
		): Promise<BlobId> {
			const cache = await loaded();
			const entry = cache.get(path);
			if (
				entry !== undefined &&
				entry.stamp === stamped.stamp &&
				Math.floor(stamped.modifiedMs / 1000) < Math.floor(entry.hashed / 1000)
			)
				return pointerBlobId(entry.oid, entry.size);
			const hashed = now();
			const { oid, size } = await hash();
			cache.set(path, { stamp: stamped.stamp, oid, size, hashed });
			dirty = true;
			return pointerBlobId(oid, size);
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
	typeof (value as Entry).oid === 'string' &&
	/^[0-9a-f]{64}$/.test((value as Entry).oid) &&
	Number.isSafeInteger((value as Entry).size) &&
	typeof (value as Entry).hashed === 'number';
