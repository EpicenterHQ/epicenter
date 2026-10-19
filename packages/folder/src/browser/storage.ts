import { createLogger } from 'wellcrafted/logger';
import { type GitObject, readCommit, readTree } from '../git/raw-objects.js';
import type { FileContent } from '../shared/merge.js';
import { snapshotObjects } from './git/closure.js';
import { readSnapshot } from './git/snapshot.js';

/** The remote tip last incorporated locally and one exact unsettled commit. */
export type RepositoryState = {
	/** undefined means no successful remote observation; null means observed empty. */
	remoteBase: string | null | undefined;
	pendingCommit: string | null;
	revision: number;
};

export type RepositorySnapshot = {
	state: RepositoryState;
	edits: Map<string, FileContent | null>;
	/** Operation-scoped committed head: unexpanded directories retain occupancy. */
	head: Awaited<ReturnType<typeof readSnapshot>>;
	/** Captured bytes remain usable after a later publication or collection. */
	objects: Map<string, GitObject>;
};

const log = createLogger('data/storage');

/**
 * A committed change to what the repository's files contain. `paths` lists the
 * paths a save wrote or deleted; null means any path may differ (a snapshot
 * was adopted). `origin` separates this handle's own publication from one
 * made through another handle, in this page or in another tab.
 */
export type StorageChange = {
	readonly paths: readonly string[] | null;
	readonly origin: 'this-handle' | 'other-handle';
};

/** The browser's own name for a failure (QuotaExceededError, AbortError) and its text. */
function reason(cause: unknown): string {
	if (typeof cause !== 'object' || cause === null) return '';
	const { name, message } = cause as { name?: unknown; message?: unknown };
	if (typeof name !== 'string' || name === 'Error') return '';
	return `: ${name}${typeof message === 'string' && message !== '' ? ` (${message})` : ''}`;
}

/** Only failures at the IndexedDB boundary become ordinary storage errors. */
export class StorageFailure extends Error {
	constructor(message: string, cause?: unknown) {
		super(`${message}${reason(cause)}`, { cause });
		this.name = 'StorageFailure';
	}
}

const initialState = (): RepositoryState => ({
	remoteBase: undefined,
	pendingCommit: null,
	revision: 0,
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

/** The key selects local data within this origin, independently of a Git remote. */
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
			// A synchronous request error (DataError, DataCloneError, an inactive
			// transaction) is the same storage failure as an aborted transaction.
			if (cause instanceof DOMException)
				throw new StorageFailure('IndexedDB request was refused', cause);
			throw cause;
		}
	}

	const listeners = new Set<(change: StorageChange) => void>();
	function notify(change: StorageChange) {
		for (const listener of [...listeners]) {
			try {
				listener(change);
			} catch (cause) {
				log.error(new Error('A repository change listener threw.', { cause }));
			}
		}
	}
	// Connections of one origin hear each other's publications. A channel does
	// not deliver to itself, so this connection notifies its own listeners.
	const channel =
		typeof BroadcastChannel === 'undefined'
			? undefined
			: new BroadcastChannel(`epicenter.data.${id}`);
	if (channel !== undefined)
		channel.onmessage = (event: MessageEvent) => {
			const { paths } = (event.data ?? {}) as { paths?: unknown };
			notify({
				origin: 'other-handle',
				paths:
					Array.isArray(paths) &&
					paths.every((path) => typeof path === 'string')
						? paths
						: null,
			});
		};

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
					requested(editStore.getAll()) as Promise<(FileContent | null)[]>,
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
						[state.remoteBase, state.pendingCommit].filter(
							(oid): oid is string => typeof oid === 'string',
						),
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
					state.pendingCommit ?? state.remoteBase ?? null,
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
		async publish(input: {
			revision: number;
			refs?: { remoteBase: string | null; pendingCommit: string | null };
			objects?: ReadonlyMap<string, GitObject>;
			/** undefined folds an incorporated edit into the published snapshot. */
			edits?: ReadonlyMap<string, FileContent | null | undefined>;
		}): Promise<boolean> {
			const published = await transact('readwrite', async (transaction) => {
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
						revision: state.revision + 1,
					},
					'state',
				);
				return true;
			});
			if (!published) return false;
			// Without refs, only the paths in E can differ (an undefined entry is a
			// save that restored C). A snapshot change may differ anywhere.
			const changed =
				input.refs === undefined ? [...(input.edits?.keys() ?? [])] : null;
			// A close during the transaction already released the channel.
			if (!closed && (changed === null || changed.length > 0)) {
				channel?.postMessage({ paths: changed });
				notify({ origin: 'this-handle', paths: changed });
			}
			return true;
		},

		/** A network acknowledgement settles the exact pending commit, not newer edits. */
		acknowledge(base: string | null, head: string): Promise<boolean> {
			return transact('readwrite', async (transaction) => {
				const meta = transaction.objectStore('meta');
				const state =
					((await requested(meta.get('state'))) as
						| RepositoryState
						| undefined) ?? initialState();
				if (state.remoteBase !== base || state.pendingCommit !== head)
					return false;
				meta.put(
					{
						...state,
						remoteBase: head,
						pendingCommit: null,
						revision: state.revision + 1,
					},
					'state',
				);
				return true;
			});
		},

		/** Mark both retained snapshots and delete other objects atomically. */
		collect(): Promise<number> {
			return transact('readwrite', async (transaction) => {
				const meta = transaction.objectStore('meta');
				const objects = transaction.objectStore('objects');
				const state =
					((await requested(meta.get('state'))) as
						| RepositoryState
						| undefined) ?? initialState();
				const live = new Set<string>();
				const pending = [state.remoteBase, state.pendingCommit]
					.filter((oid): oid is string => typeof oid === 'string')
					.map((oid) => ({ oid, type: 'commit' as GitObject['type'] }));
				for (
					let next = pending.pop();
					next !== undefined;
					next = pending.pop()
				) {
					const { oid, type } = next;
					if (live.has(oid)) continue;
					const object = (await requested(objects.get(oid))) as
						| GitObject
						| undefined;
					if (object === undefined)
						throw new StorageFailure(`Repository object ${oid} is missing`);
					if (object.type !== type)
						throw new StorageFailure(
							`Expected ${type} object ${oid}, found ${object.type}`,
						);
					live.add(oid);
					if (type === 'commit')
						pending.push({ oid: readCommit(object.bytes).tree, type: 'tree' });
					if (type === 'tree') {
						for (const entry of readTree(object.bytes)) {
							if (entry.mode === '160000') continue;
							pending.push({
								oid: entry.oid,
								type:
									entry.mode === '40000' || entry.mode === '040000'
										? 'tree'
										: 'blob',
							});
						}
					}
				}
				let removed = 0;
				for (const key of await requested(objects.getAllKeys())) {
					if (live.has(String(key))) continue;
					objects.delete(key);
					removed++;
				}
				return removed;
			});
		},

		/** Delivered after a publication commits, never before it is durable. */
		subscribe(listener: (change: StorageChange) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		close() {
			closed = true;
			listeners.clear();
			if (channel !== undefined) {
				channel.onmessage = null;
				channel.close();
			}
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

/** Saved edits are relative to the committed head, including null tombstones. */
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
