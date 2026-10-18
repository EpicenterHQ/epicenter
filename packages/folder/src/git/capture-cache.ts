/**
 * The stat cache a capture reads before it reads a file: for each path, the
 * size, modification time, and stamp the listing gave when its bytes were
 * last read, and the blob ID those bytes hash to. A file whose listing
 * still says exactly that is not read or hashed again. It is Git's index
 * stat data, kept apart from the index: the browser's index never trusts
 * its stats, and the native one belongs to every Git program on the
 * machine.
 *
 * The cache only saves work. A capture with no cache, an unreadable one, or
 * one in another format reads every file, and records the same commit. A
 * capture never trusts an entry it has doubts about:
 *
 * - An entry is recorded only for a file whose modification time is more
 *   than `RACY_MS` older than the moment its listing began, on the host's
 *   own clock (`listedAt`). Any later write to it, including one in the
 *   instant between the listing and the read, gets a time at or after that
 *   moment, so its listing can no longer match; `RACY_MS` covers file
 *   systems that keep times in whole seconds or two. This is Git's racy
 *   timestamp rule, measured from the listing instead of the index write.
 * - The stat recorded is the listing's, taken before the read, so bytes that
 *   changed between the two are recorded under a stat that no longer
 *   matches, and are read again.
 * - The whole file carries the SHA-256 of its entries; anything that does
 *   not check is no cache.
 *
 * There is no migration: a cache in any other format is discarded and
 * rebuilt by the next capture.
 */
import { hashBytes } from '../hash.js';

/**
 * How much older than its listing a file's modification time must be before
 * its blob ID is remembered. FAT keeps times in two-second steps.
 */
export const RACY_MS = 3000;

/** Where the cache lives, below the folder's private `.git`. */
export const CAPTURE_CACHE_PATH = 'epicenter/capture-cache';

const HEADER = 'epicenter capture cache 1';
const OID = /^[0-9a-f]{40}$/;

/** What a listing said of a file when its bytes hashed to `oid`. */
export type StatEntry = {
	readonly size: number;
	readonly modified: number;
	readonly stamp: string | undefined;
	readonly oid: string;
};

export type StatCache = ReadonlyMap<string, StatEntry>;

/** What the listing says of one file now. */
type Listed = {
	readonly size: number;
	readonly modified?: number;
	readonly stamp?: string;
};

/** The blob ID `cache` holds for a file listed as `listed`, if every stat matches. */
export function cachedOid(
	cache: StatCache,
	path: string,
	listed: Listed,
): string | undefined {
	const entry = cache.get(path);
	if (entry === undefined || listed.modified === undefined) return undefined;
	if (
		entry.size !== listed.size ||
		entry.modified !== listed.modified ||
		entry.stamp !== listed.stamp
	)
		return undefined;
	return entry.oid;
}

/**
 * The entry to remember for a file listed as `listed`, whose bytes, read
 * after a listing that began at `listedAt`, hash to `oid`; `undefined` when
 * its time is too recent, or missing, to vouch for it later.
 */
export function entryFor(
	listed: Listed,
	listedAt: number | undefined,
	oid: string,
): StatEntry | undefined {
	const { modified } = listed;
	if (listedAt === undefined || modified === undefined) return undefined;
	// A host that times nothing, or times every file at the epoch, never
	// vouches for one.
	if (!(modified > 0 && modified < listedAt - RACY_MS)) return undefined;
	return { size: listed.size, modified, stamp: listed.stamp, oid };
}

/** Whether two caches hold the same entries. */
export function sameCache(a: StatCache, b: StatCache): boolean {
	if (a.size !== b.size) return false;
	for (const [path, entry] of a) {
		const other = b.get(path);
		if (
			other === undefined ||
			other.oid !== entry.oid ||
			other.size !== entry.size ||
			other.modified !== entry.modified ||
			other.stamp !== entry.stamp
		)
			return false;
	}
	return true;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function serializeCache(cache: StatCache): Promise<Uint8Array> {
	const body = JSON.stringify(
		[...cache].map(([path, { size, modified, stamp, oid }]) => [
			path,
			size,
			modified,
			stamp ?? null,
			oid,
		]),
	);
	const sum = await hashBytes(encoder.encode(body));
	return encoder.encode(`${HEADER} ${sum}\n${body}`);
}

/** The entries `bytes` holds, or none when anything about them is unexpected. */
export async function parseCache(
	bytes: Uint8Array | undefined,
): Promise<StatCache> {
	const none = new Map<string, StatEntry>();
	if (bytes === undefined) return none;
	try {
		const text = decoder.decode(bytes);
		const newline = text.indexOf('\n');
		if (newline < 0) return none;
		const body = text.slice(newline + 1);
		const sum = await hashBytes(encoder.encode(body));
		if (text.slice(0, newline) !== `${HEADER} ${sum}`) return none;
		const entries: unknown = JSON.parse(body);
		if (!Array.isArray(entries)) return none;
		const cache = new Map<string, StatEntry>();
		for (const entry of entries) {
			if (!Array.isArray(entry) || entry.length !== 5) return none;
			const [path, size, modified, stamp, oid] = entry as unknown[];
			if (
				typeof path !== 'string' ||
				typeof size !== 'number' ||
				typeof modified !== 'number' ||
				(stamp !== null && typeof stamp !== 'string') ||
				typeof oid !== 'string' ||
				!OID.test(oid)
			)
				return none;
			cache.set(path, { size, modified, stamp: stamp ?? undefined, oid });
		}
		return cache;
	} catch {
		return none;
	}
}
