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
 *   own clock (`listedAt`). The rule rests on two facts of the hosts: a
 *   listing sees a file's old bytes and old time until the write that
 *   replaces them lands, and a file's times only move forward. A write that
 *   lands after the listing is timed when the host stamps it (when it began
 *   writing, or when it closed, in whole seconds on some), which is never
 *   more than `RACY_MS` before the listing, so its listing can no longer
 *   match a recorded time. This is Git's racy timestamp rule, measured from
 *   the listing instead of the index write.
 * - The stat recorded is the listing's, taken before the read, so bytes that
 *   changed between the two are recorded under a stat that no longer
 *   matches, and are read again.
 * - A wall clock stepped back breaks "only forward". The cache keeps the
 *   latest `listedAt` that wrote it, and a listing that begins before it
 *   finds no cache. A path the folder writes itself, or hears another page
 *   wrote, is dropped from the cache at once (`forget` in `history.ts`), so
 *   only a write nobody reported, under a clock stepped back and moved past
 *   the mark again, is left to the timestamps alone.
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

const HEADER = 'epicenter capture cache 2';
const OID = /^[0-9a-f]{40}$/;

/** What a listing said of a file when its bytes hashed to `oid`. */
export type StatEntry = {
	readonly size: number;
	readonly modified: number;
	readonly stamp: string | undefined;
	readonly oid: string;
};

/**
 * The entries, and the latest listing time of the captures that recorded
 * them: a listing that begins before it was taken on a clock stepped back.
 */
export type StatCache = {
	readonly entries: ReadonlyMap<string, StatEntry>;
	readonly listedAt: number;
};

export const NO_CACHE: StatCache = { entries: new Map(), listedAt: 0 };

/**
 * `cache` as a listing that began at `listedAt` may use it: none when the
 * listing gives no time, or began before the cache's latest listing.
 */
export function usableCache(
	cache: StatCache,
	listedAt: number | undefined,
): StatCache {
	if (listedAt === undefined || listedAt < cache.listedAt) return NO_CACHE;
	return cache;
}

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
	const entry = cache.entries.get(path);
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

/** Whether two caches hold the same entries and listing time. */
export function sameCache(a: StatCache, b: StatCache): boolean {
	if (a.listedAt !== b.listedAt || a.entries.size !== b.entries.size)
		return false;
	for (const [path, entry] of a.entries) {
		const other = b.entries.get(path);
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
	const body = JSON.stringify({
		listedAt: cache.listedAt,
		entries: [...cache.entries].map(
			([path, { size, modified, stamp, oid }]) => [
				path,
				size,
				modified,
				stamp ?? null,
				oid,
			],
		),
	});
	const sum = await hashBytes(encoder.encode(body));
	return encoder.encode(`${HEADER} ${sum}\n${body}`);
}

/** The cache `bytes` hold, or none when anything about them is unexpected. */
export async function parseCache(
	bytes: Uint8Array | undefined,
): Promise<StatCache> {
	if (bytes === undefined) return NO_CACHE;
	try {
		const text = decoder.decode(bytes);
		const newline = text.indexOf('\n');
		if (newline < 0) return NO_CACHE;
		const body = text.slice(newline + 1);
		const sum = await hashBytes(encoder.encode(body));
		if (text.slice(0, newline) !== `${HEADER} ${sum}`) return NO_CACHE;
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed !== 'object' || parsed === null) return NO_CACHE;
		const { listedAt, entries } = parsed as Record<string, unknown>;
		if (typeof listedAt !== 'number' || !Array.isArray(entries))
			return NO_CACHE;
		const cache = new Map<string, StatEntry>();
		for (const entry of entries) {
			if (!Array.isArray(entry) || entry.length !== 5) return NO_CACHE;
			const [path, size, modified, stamp, oid] = entry as unknown[];
			if (
				typeof path !== 'string' ||
				typeof size !== 'number' ||
				typeof modified !== 'number' ||
				(stamp !== null && typeof stamp !== 'string') ||
				typeof oid !== 'string' ||
				!OID.test(oid)
			)
				return NO_CACHE;
			cache.set(path, { size, modified, stamp: stamp ?? undefined, oid });
		}
		return { entries: cache, listedAt };
	} catch {
		return NO_CACHE;
	}
}
