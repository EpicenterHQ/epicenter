import { snapshotObjects } from './git/closure.js';
import type { GitObject } from './git/objects.js';
import { readSnapshot } from './git/snapshot.js';

/** B, C and the explicit boundary beyond which retained snapshots need no parents. */
export type RepositoryRefs = {
	base: string | null;
	head: string | null;
	shallow: readonly string[];
};

export type RepositoryState = RepositoryRefs & {
	revision: number;
	remoteKnown: boolean;
};

export type RepositorySnapshot = {
	state: RepositoryState;
	edits: Map<string, string | null>;
	/** Operation-scoped C: unexpanded directories retain occupancy, not children. */
	head: Awaited<ReturnType<typeof readSnapshot>>;
	/** Captured bytes remain usable after a later publication or collection. */
	objects: Map<string, GitObject>;
};

/** Only failures at the IndexedDB boundary become ordinary storage errors. */
export class StorageFailure extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, { cause });
		this.name = 'StorageFailure';
	}
}

const initialState = (): RepositoryState => ({
	base: null,
	head: null,
	shallow: [],
	revision: 0,
	remoteKnown: false,
});

function requested<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(new StorageFailure('IndexedDB request failed', request.error));
	});
}

function completed(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(
				new StorageFailure('IndexedDB transaction aborted', transaction.error),
			);
	});
}

/** One database per origin/repository; no page owns its writes or synchronization. */
export async function openStorage(id: string) {
	let opening: IDBOpenDBRequest;
	try {
		opening = indexedDB.open(`epicenter.data.${id}`, 1);
	} catch (cause) {
		if (!(cause instanceof DOMException)) throw cause;
		throw new StorageFailure('IndexedDB could not be opened', cause);
	}
	opening.onupgradeneeded = () => {
		const database = opening.result;
		database.createObjectStore('meta');
		database.createObjectStore('objects');
		database.createObjectStore('edits');
	};
	const database = await requested(opening);
	// A future schema upgrade must not wait for a suspended page to close itself.
	database.onversionchange = () => database.close();
	let closed = false;

	async function transact<T>(
		mode: IDBTransactionMode,
		work: (transaction: IDBTransaction) => Promise<T>,
	) {
		if (closed)
			throw new StorageFailure(
				'Repository closed before the operation completed',
			);
		let transaction: IDBTransaction;
		try {
			transaction = database.transaction(
				['meta', 'objects', 'edits'],
				mode,
				mode === 'readwrite' ? { durability: 'strict' } : undefined,
			);
		} catch (cause) {
			if (!(cause instanceof DOMException)) throw cause;
			throw new StorageFailure('IndexedDB transaction could not start', cause);
		}
		const completion = completed(transaction);
		// The request rejection and abort event may occur in different tasks.
		completion.catch(() => {});
		try {
			const result = await work(transaction);
			await completion;
			return result;
		} catch (cause) {
			try {
				transaction.abort();
			} catch {
				/* Already completed or aborted. */
			}
			await completion.catch(() => {});
			throw cause;
		}
	}

	return {
		/**
		 * Read refs, edits and required current-snapshot bytes in one transaction.
		 * Omitted scope captures all files; [] captures all trees without blobs.
		 * Point, prefix, row-list and commit scopes avoid unrelated subtrees. Every
		 * pending-edit ancestor is expanded so deletions can remove its occupancy.
		 * Only IndexedDB request promises are awaited while the transaction is live.
		 */
		capture(
			scope?:
				| readonly string[]
				| { prefix: string }
				| { rows: string }
				| 'commit'
				| 'sync',
		): Promise<RepositorySnapshot> {
			return transact('readonly', async (transaction) => {
				const meta = transaction.objectStore('meta');
				const objectStore = transaction.objectStore('objects');
				const editStore = transaction.objectStore('edits');
				const [storedState, keys, values] = await Promise.all([
					requested(meta.get('state')) as Promise<RepositoryState | undefined>,
					requested(editStore.getAllKeys()),
					requested(editStore.getAll()) as Promise<(string | null)[]>,
				]);
				const state = storedState ?? initialState();
				const edits = new Map(
					keys.map((key, index) => [String(key), values[index]!]),
				);
				const objects = new Map<string, GitObject>();
				async function read(oid: string): Promise<GitObject> {
					const cached = objects.get(oid);
					if (cached !== undefined) return cached;
					const object = (await requested(objectStore.get(oid))) as
						| GitObject
						| undefined;
					if (object === undefined)
						throw new StorageFailure(`Repository object ${oid} is missing`);
					objects.set(oid, object);
					return object;
				}
				const full =
					scope === undefined ||
					scope === 'sync' ||
					(Array.isArray(scope) && scope.length === 0);
				if (scope === 'sync')
					await snapshotObjects(
						[state.base, state.head].filter((oid) => oid !== null),
						read,
					);
				const editAncestors = new Set<string>();
				for (const path of edits.keys()) {
					for (
						let end = path.lastIndexOf('/');
						end > 0;
						end = path.lastIndexOf('/', end - 1)
					)
						editAncestors.add(path.slice(0, end));
				}
				function descend(path: string): boolean {
					if (editAncestors.has(path)) return true;
					if (scope === 'commit' || scope === 'sync' || scope === undefined)
						return false;
					if ('prefix' in scope)
						return (
							path.startsWith(scope.prefix) ||
							scope.prefix.startsWith(`${path}/`)
						);
					if ('rows' in scope) return path === scope.rows;
					return scope.some((selected) => selected.startsWith(`${path}/`));
				}
				const head = await readSnapshot(
					state.head,
					read,
					full ? undefined : descend,
				);
				let selected: Iterable<string> = [];
				if (scope === undefined) selected = head.files.keys();
				else if (typeof scope === 'object' && 'rows' in scope)
					selected = [...head.files.keys()].filter(
						(path) =>
							path.startsWith(`${scope.rows}/`) &&
							path.endsWith('.md') &&
							!path.slice(scope.rows.length + 1).includes('/'),
					);
				else if (typeof scope === 'object' && !('prefix' in scope))
					selected = scope;
				for (const path of selected) {
					const entry = head.files.get(path);
					// A gitlink names another repository, not a local blob to load.
					if (entry !== undefined && entry.mode !== '160000')
						await read(entry.oid);
				}
				return { state, edits, head, objects };
			});
		},

		/** Hashes and merges happen before this transaction, never inside it. */
		publish(input: {
			revision: number;
			refs?: RepositoryRefs;
			/** Set only alongside a successful first-fetch adoption (empty included). */
			remoteKnown?: true;
			objects?: ReadonlyMap<string, GitObject>;
			/** undefined folds an incorporated edit into the published snapshot. */
			edits?: ReadonlyMap<string, string | null | undefined>;
		}): Promise<boolean> {
			return transact('readwrite', async (transaction) => {
				const meta = transaction.objectStore('meta');
				const state =
					((await requested(meta.get('state'))) as
						| RepositoryState
						| undefined) ?? initialState();
				if (state.revision !== input.revision) return false;
				const objectStore = transaction.objectStore('objects');
				for (const [oid, object] of input.objects ?? [])
					objectStore.put(object, oid);
				const editStore = transaction.objectStore('edits');
				for (const [path, text] of input.edits ?? []) {
					if (text === undefined) editStore.delete(path);
					else editStore.put(text, path);
				}
				meta.put(
					{
						...state,
						...input.refs,
						remoteKnown: input.remoteKnown ?? state.remoteKnown,
						revision: state.revision + 1,
					},
					'state',
				);
				return true;
			});
		},

		/** A network acknowledgement is about exact B/C, independent of newer E. */
		acknowledge(base: string | null, head: string): Promise<boolean> {
			return transact('readwrite', async (transaction) => {
				const meta = transaction.objectStore('meta');
				const state =
					((await requested(meta.get('state'))) as
						| RepositoryState
						| undefined) ?? initialState();
				if (state.base !== base || state.head !== head) return false;
				if (state.base === head) return true;
				meta.put(
					{
						...state,
						base: head,
						shallow: [head],
						revision: state.revision + 1,
					},
					'state',
				);
				return true;
			});
		},

		close() {
			closed = true;
			database.close();
		},
	};
}

export type RepositoryStorage = Awaited<ReturnType<typeof openStorage>>;

export function snapshotObject(
	snapshot: RepositorySnapshot,
	oid: string,
): GitObject {
	const object = snapshot.objects.get(oid);
	if (object === undefined)
		throw new Error(`Snapshot did not capture object ${oid}`);
	return object;
}

/** Pending edits are relative to head, including null tombstones. */
export function snapshotContent(
	snapshot: RepositorySnapshot,
	path: string,
): string | Uint8Array | null {
	if (snapshot.edits.has(path)) return snapshot.edits.get(path)!;
	if (shadowed(snapshot.edits, path)) return null;
	const entry = snapshot.head.files.get(path);
	if (entry === undefined || entry.mode === '160000') return null;
	return snapshotObject(snapshot, entry.oid).bytes;
}

export function snapshotPaths(snapshot: RepositorySnapshot): Set<string> {
	const paths = new Set(
		[...snapshot.head.files.keys()].filter(
			(path) => !shadowed(snapshot.edits, path),
		),
	);
	for (const [path, text] of snapshot.edits) {
		if (text !== null) paths.add(path);
	}
	return paths;
}

/** An edit at an ancestor replaces that committed subtree; explicit child E wins. */
export function shadowed(
	edits: ReadonlyMap<string, unknown>,
	path: string,
): boolean {
	for (let end = path.length; end > 0; end = path.lastIndexOf('/', end - 1)) {
		if (edits.has(path.slice(0, end))) return true;
	}
	return false;
}

/** Raw or unexpanded occupancy survives when files alone cannot describe it. */
export function snapshotDirectories(snapshot: RepositorySnapshot): Set<string> {
	const directories = new Set<string>();
	function addParents(path: string) {
		for (
			let end = path.lastIndexOf('/');
			end > 0;
			end = path.lastIndexOf('/', end - 1)
		)
			directories.add(path.slice(0, end));
	}
	for (const path of snapshotPaths(snapshot)) addParents(path);
	for (const path of snapshot.head.opaqueDirectories) {
		if (shadowed(snapshot.edits, path)) continue;
		directories.add(path);
		addParents(path);
	}
	return directories;
}
