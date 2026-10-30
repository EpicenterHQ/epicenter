/**
 * A device's cache of files it uploaded (decision 66): once the server has
 * a capture's audio, the device keeps those bytes, read only, so an app can
 * play and transcribe recent recordings offline. It is not an outbox:
 * nothing in it is ever sent, edited or merged, and losing any of it loses
 * nothing, since the server holds every byte.
 *
 * Each file sits at `.epicenter/cache/<its contract path>`. The path is
 * hidden, so no collection claims it: the device client never lists it, an
 * upload never adopts it, and `epicenter check` skips it. Only files other
 * than notes are kept: their bytes are named by their LFS oid, so a cached
 * file is either exactly the repository's version or not it, never a stale
 * copy that drifts. A note is the repository's to change, so the browser
 * keeps none (decision 11).
 *
 * The outbox fills it as it lets go of an uploaded file whose bytes the
 * server's reply shows at that path (`keep`). It is dropped:
 *
 * - by the browser, which may evict this origin's storage at any time (a
 *   miss is ordinary: read the remote);
 * - past `CACHE_LIMIT` files, the first in file-name order first (for
 *   `timeId()` names, the oldest);
 * - when the account that uploaded it is retired (`startUploading` clears
 *   it on sign-out or another person signing in);
 * - or explicitly, with `clear()`.
 */
import {
	ClientError,
	type CompiledContract,
	type Contract,
	type PlaceholdersOf,
	storedWithLfs,
	type Version,
} from '@epicenter/definition/contract';
import { gitBlobHash, writePointer } from '@epicenter/definition/merge';
import type { InferError } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { DeviceStore } from './store.js';

/** Where a device keeps the files it uploaded. */
export const CACHE_DIRECTORY = '.epicenter/cache';

/** The most files the cache holds. */
export const CACHE_LIMIT = 32;

type Invalid = InferError<typeof ClientError.Invalid>;
type Unavailable = InferError<typeof ClientError.Unavailable>;

/** One cached file: its collection and placeholders, as the contract names it. */
export type CachedFile<TContract extends Contract> = {
	[K in keyof TContract['collections'] & string]: {
		collection: K;
	} & PlaceholdersOf<TContract['collections'][K]>;
}[keyof TContract['collections'] & string];

/**
 * The repository's version (the Git blob id `main` holds) of the file whose
 * bytes have the device `version` (their sha256, which is the LFS oid) and
 * `size`: the blob of the LFS pointer naming them.
 */
export const repositoryVersionOf = (version: Version, size: number) =>
	gitBlobHash(writePointer({ oid: version, size })) as Version;

const leaf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export function createCache<TContract extends Contract>(
	compiled: CompiledContract,
	store: DeviceStore,
) {
	const at = (path: string) => `${CACHE_DIRECTORY}/${path}`;

	/** Every cached file's contract path, oldest (by file name) first. */
	async function paths(): Promise<Result<string[], Unavailable>> {
		const listed = await store.list();
		if (listed.error !== null) return listed;
		const prefix = `${CACHE_DIRECTORY}/`;
		return Ok(
			listed.data
				.map(({ path }) => path)
				.filter((path) => path.startsWith(prefix))
				.map((path) => path.slice(prefix.length))
				.sort((a, b) =>
					leaf(a) === leaf(b) ? (a < b ? -1 : 1) : leaf(a) < leaf(b) ? -1 : 1,
				),
		);
	}

	/** The contract path of `file`, or why it has none. */
	function pathOf(file: CachedFile<TContract>): Result<string, Invalid> {
		const { collection: name, ...params } = file as {
			collection: string;
		} & Record<string, unknown>;
		const collection = compiled.collections.find((c) => c.name === name);
		const path = collection?.pathOf(params);
		if (path !== undefined && path.error === null) return Ok(path.data);
		return ClientError.Invalid({
			path: null,
			issues: [
				{
					field: 'collection',
					message:
						path?.error.message ?? `The contract has no collection '${name}'`,
				},
			],
		});
	}

	const drop = (path: string) => store.write(at(path), null, 'any');

	return {
		/**
		 * Keep `bytes`, uploaded from `path`, then drop the oldest files past
		 * `CACHE_LIMIT`. Only the outbox calls this, for a file the server's
		 * reply shows at `path` as these bytes.
		 */
		async keep(
			path: string,
			bytes: Uint8Array,
		): Promise<Result<void, Unavailable>> {
			if (!storedWithLfs(path)) return Ok(undefined);
			const written = await store.write(at(path), bytes, 'any');
			if (written.error !== null) return written;
			const cached = await paths();
			if (cached.error !== null) return cached;
			for (const old of cached.data.slice(
				0,
				Math.max(0, cached.data.length - CACHE_LIMIT),
			)) {
				const dropped = await drop(old);
				if (dropped.error !== null) return dropped;
			}
			return Ok(undefined);
		},
		/** Every cached file, oldest (by file name) first. */
		async list(): Promise<
			Result<{ items: CachedFile<TContract>[] }, Unavailable>
		> {
			const cached = await paths();
			if (cached.error !== null) return cached;
			const items: CachedFile<TContract>[] = [];
			for (const path of cached.data) {
				const claim = compiled.claim(path);
				if (claim === null) continue;
				items.push({
					collection: claim.collection.name,
					...claim.params,
				} as CachedFile<TContract>);
			}
			return Ok({ items });
		},
		/**
		 * The cached bytes of `file` and their device version, or null when
		 * none are cached. Given the repository's `version` of the file (what
		 * the remote client lists), it answers only with those bytes: a cached
		 * file the repository has since replaced is dropped, and is null.
		 */
		async read(
			file: CachedFile<TContract>,
			{ version }: { version?: Version } = {},
		): Promise<
			Result<{ bytes: Uint8Array; version: Version } | null, Invalid | Unavailable>
		> {
			const path = pathOf(file);
			if (path.error !== null) return path;
			const read = await store.read(at(path.data));
			if (read.error !== null) return read;
			if (read.data === null) return Ok(null);
			const { bytes, version: held } = read.data;
			if (
				version !== undefined &&
				repositoryVersionOf(held, bytes.byteLength) !== version
			) {
				const dropped = await drop(path.data);
				if (dropped.error !== null) return dropped;
				return Ok(null);
			}
			return Ok({ bytes, version: held });
		},
		/** Drop every cached file. */
		async clear(): Promise<Result<void, Unavailable>> {
			const cached = await paths();
			if (cached.error !== null) return cached;
			for (const path of cached.data) {
				const dropped = await drop(path);
				if (dropped.error !== null) return dropped;
			}
			return Ok(undefined);
		},
	};
}

/** What an app may do with a device's cache: read it, or drop it. */
export type Cache<TContract extends Contract> = Omit<
	ReturnType<typeof createCache<TContract>>,
	'keep'
>;
