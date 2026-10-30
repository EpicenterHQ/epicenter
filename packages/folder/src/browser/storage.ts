import { createLogger } from 'wellcrafted/logger';
import { type GitObject, readCommit, readTree } from '../git/raw-objects.js';
import { snapshotObjects } from './git/closure.js';
import { emptyTree, readSnapshot } from './git/snapshot.js';

/** Rule files are regular files; Git does not follow a symlinked .gitignore. */
function isIgnoreFile(path: string, mode: string) {
	return (
		(path === '.gitignore' || path.endsWith('/.gitignore')) &&
		(mode === '100644' || mode === '100755')
	);
}

/** One saved folder and the two checkpoints needed to settle Git exchange. */
export type RepositoryState = {
	workingTree: string;
	/** undefined means no successful remote observation; null means observed empty. */
	remoteBase: string | null | undefined;
	pendingCommit: string | null;
	/** Conservative upper bound on retired bytes since the last collection. */
	retiredBytes: number;
};

const log = createLogger('folder/storage');

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
	workingTree: emptyTree,
	remoteBase: undefined,
	pendingCommit: null,
	retiredBytes: 0,
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
		opening = indexedDB.open(`epicenter.folder.${id}`, 1);
	} catch (cause) {
		if (!(cause instanceof DOMException)) throw cause;
		throw new StorageFailure('IndexedDB could not be opened', cause);
	}
	opening.onupgradeneeded = () => {
		const database = opening.result;
		database.createObjectStore('meta').put(initialState(), 'state');
		const objects = database.createObjectStore('objects');
		objects.createIndex('type', 'type');
		objects.put(
			{ type: 'tree', bytes: new Uint8Array() } satisfies GitObject,
			emptyTree,
		);
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
				['meta', 'objects'],
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
			: new BroadcastChannel(`epicenter.folder.${id}`);
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

	/** Collection is maintenance after durable success; its failure costs space. */
	async function maintain() {
		try {
			await storage.collect();
		} catch (cause) {
			log.warn(
				new Error('Folder object collection failed after publication', {
					cause,
				}),
			);
		}
	}

	const storage = {
		/**
		 * Capture working-tree inputs in one transaction. A sync capture also
		 * includes complete checkpoint and working closures. Other scopes only
		 * expand the trees they need; unexpanded entries retain occupancy.
		 * Only IndexedDB requests are awaited while the transaction is live.
		 */
		capture(
			scope?:
				| readonly string[]
				| { prefix: string }
				| { rows: string }
				| 'sync',
		) {
			return transact('readonly', async (transaction) => {
				const state = (await requested(
					transaction.objectStore('meta').get('state'),
				)) as RepositoryState;
				const objectStore = transaction.objectStore('objects');
				async function load(oid: string): Promise<GitObject> {
					const object = (await requested(objectStore.get(oid))) as
						| GitObject
						| undefined;
					if (object === undefined)
						throw new StorageFailure(`Repository object ${oid} is missing`);
					return object;
				}
				// The complete closure map owns sync capture; do not populate a
				// second cache alongside its traversal.
				const objects =
					scope === 'sync'
						? await snapshotObjects(
								[state.remoteBase, state.pendingCommit].filter(
									(oid): oid is string => typeof oid === 'string',
								),
								load,
								[state.workingTree],
							)
						: new Map<string, GitObject>();
				async function read(oid: string): Promise<GitObject> {
					const cached = objects.get(oid);
					if (cached !== undefined) return cached;
					const object = await load(oid);
					objects.set(oid, object);
					return object;
				}
				function descend(path: string): boolean {
					if (scope === undefined || scope === 'sync') return true;
					if ('prefix' in scope)
						return (
							path.startsWith(scope.prefix) ||
							scope.prefix.startsWith(`${path}/`)
						);
					if ('rows' in scope) return path === scope.rows;
					return scope.some((selected) => selected.startsWith(`${path}/`));
				}
				const full =
					scope === undefined ||
					scope === 'sync' ||
					(Array.isArray(scope) && scope.length === 0);
				const tree = await readSnapshot(
					state.workingTree,
					read,
					full ? undefined : descend,
				);
				let selected: Iterable<string> = [];
				if (scope === undefined) selected = tree.files.keys();
				else if (typeof scope === 'object' && 'rows' in scope)
					selected = [...tree.files.keys()].filter(
						(path) =>
							path.startsWith(`${scope.rows}/`) &&
							path.endsWith('.md') &&
							!path.slice(scope.rows.length + 1).includes('/'),
					);
				else if (typeof scope === 'object' && !('prefix' in scope))
					selected = scope;
				for (const path of selected) {
					const entry = tree.files.get(path);
					if (entry !== undefined && entry.mode !== '160000')
						await read(entry.oid);
				}
				return { state, ...tree, objects };
			});
		},

		/** Capture preparation's trees and ignore bytes, without loading other blobs. */
		checkpoint() {
			return transact('readonly', async (transaction) => {
				const state = (await requested(
					transaction.objectStore('meta').get('state'),
				)) as RepositoryState;
				const objects = new Map<string, GitObject>();
				const read = async (oid: string): Promise<GitObject> => {
					const cached = objects.get(oid);
					if (cached !== undefined) return cached;
					const object = (await requested(
						transaction.objectStore('objects').get(oid),
					)) as GitObject | undefined;
					if (object === undefined)
						throw new StorageFailure(`Repository object ${oid} is missing`);
					objects.set(oid, object);
					return object;
				};
				let baseTree: string | null = null;
				if (state.remoteBase != null && state.pendingCommit === null) {
					const object = await read(state.remoteBase);
					if (object.type !== 'commit')
						throw new StorageFailure(
							`Confirmed commit ${state.remoteBase} has the wrong type`,
						);
					baseTree = readCommit(object.bytes).tree;
				}
				if (
					state.remoteBase !== undefined &&
					state.pendingCommit === null &&
					state.workingTree !== (baseTree ?? emptyTree)
				) {
					const current = await readSnapshot(state.workingTree, read);
					await readSnapshot(baseTree, read);
					for (const [path, entry] of current.files)
						if (isIgnoreFile(path, entry.mode)) await read(entry.oid);
				}
				return { state, baseTree, objects };
			});
		},

		/** Hash outside this transaction. Local saves guard W; sync guards W/B/P. */
		async publish(
			input: {
				workingTree?: string;
				objects?: ReadonlyMap<string, GitObject>;
				retiredBytes?: number;
				paths?: readonly string[];
			} & (
				| { expected: string; refs?: never }
				| {
						expected: RepositoryState;
						refs?: { remoteBase: string | null; pendingCommit: string | null };
				  }
			),
		): Promise<boolean> {
			async function publish() {
				return transact('readwrite', async (transaction) => {
					const meta = transaction.objectStore('meta');
					const state = (await requested(meta.get('state'))) as RepositoryState;
					const expected = input.expected;
					if (
						state.workingTree !==
						(typeof expected === 'string' ? expected : expected.workingTree)
					)
						return null;
					if (
						typeof expected !== 'string' &&
						(state.remoteBase !== expected.remoteBase ||
							state.pendingCommit !== expected.pendingCommit)
					)
						return null;
					const objects = transaction.objectStore('objects');
					for (const [oid, object] of input.objects ?? [])
						objects.put(object, oid);
					const next = {
						...state,
						...input.refs,
						workingTree: input.workingTree ?? state.workingTree,
						retiredBytes: state.retiredBytes + (input.retiredBytes ?? 0),
					};
					meta.put(next, 'state');
					return {
						changed: next.workingTree !== state.workingTree,
						collect:
							next.retiredBytes >= 8 * 1024 * 1024 ||
							next.remoteBase !== state.remoteBase ||
							(state.pendingCommit !== null &&
								next.pendingCommit !== state.pendingCommit),
					};
				});
			}
			let result: Awaited<ReturnType<typeof publish>>;
			try {
				result = await publish();
			} catch (cause) {
				if (
					!(cause instanceof StorageFailure) ||
					!(cause.cause instanceof DOMException) ||
					cause.cause.name !== 'QuotaExceededError'
				)
					throw cause;
				await storage.collect();
				result = await publish();
			}
			if (result === null) return false;
			if (!closed && result.changed) {
				const paths = input.paths ?? null;
				channel?.postMessage({ paths });
				notify({ origin: 'this-handle', paths });
			}
			if (result.collect) await maintain();
			return true;
		},

		/** Settle the exact send while retaining the latest working tree. */
		async acknowledge(base: string | null, head: string): Promise<boolean> {
			const accepted = await transact('readwrite', async (transaction) => {
				const meta = transaction.objectStore('meta');
				const state = (await requested(meta.get('state'))) as RepositoryState;
				if (state.remoteBase !== base || state.pendingCommit !== head)
					return false;
				meta.put({ ...state, remoteBase: head, pendingCommit: null }, 'state');
				return true;
			});
			if (accepted) await maintain();
			return accepted;
		},

		/** Keep W and both checkpoint snapshots, without traversing commit parents. */
		collect(): Promise<number> {
			return transact('readwrite', async (transaction) => {
				const meta = transaction.objectStore('meta');
				const objects = transaction.objectStore('objects');
				const state = (await requested(meta.get('state'))) as RepositoryState;
				const blobs = new Set(
					(await requested(objects.index('type').getAllKeys('blob'))).map(
						String,
					),
				);
				const live = new Set<string>();
				const pending = [
					{ oid: state.workingTree, type: 'tree' as GitObject['type'] },
					...[state.remoteBase, state.pendingCommit]
						.filter((oid): oid is string => typeof oid === 'string')
						.map((oid) => ({ oid, type: 'commit' as GitObject['type'] })),
				];
				for (
					let next = pending.pop();
					next !== undefined;
					next = pending.pop()
				) {
					const { oid, type } = next;
					// Check every incoming edge's type, even for a previously visited hash.
					if (type === 'blob') {
						if (!blobs.has(oid))
							throw new StorageFailure(
								`Blob object ${oid} is missing or has the wrong type`,
							);
						live.add(oid);
						continue;
					}
					const object = (await requested(objects.get(oid))) as
						| GitObject
						| undefined;
					if (object === undefined)
						throw new StorageFailure(`Repository object ${oid} is missing`);
					if (object.type !== type)
						throw new StorageFailure(
							`Expected ${type} object ${oid}, found ${object.type}`,
						);
					if (live.has(oid)) continue;
					live.add(oid);
					if (type === 'commit')
						pending.push({ oid: readCommit(object.bytes).tree, type: 'tree' });
					if (type === 'tree')
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
				let removed = 0;
				for (const key of await requested(objects.getAllKeys())) {
					if (live.has(String(key))) continue;
					objects.delete(key);
					removed++;
				}
				meta.put({ ...state, retiredBytes: 0 }, 'state');
				return removed;
			});
		},

		/** Delivered after a publication commits, never before it is durable. */
		subscribe(listener: (change: StorageChange) => void): () => void {
			if (closed) throw new Error('Repository is closed');
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		get closed() {
			return closed;
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
	return storage;
}

export type RepositoryStorage = Awaited<ReturnType<typeof openStorage>>;
/** Consistent bytes remain usable after later saves or collection. */
export type RepositorySnapshot = Awaited<
	ReturnType<RepositoryStorage['capture']>
>;

export function snapshotObject(
	snapshot: RepositorySnapshot,
	oid: string,
): GitObject {
	const object = snapshot.objects.get(oid);
	if (object === undefined)
		throw new Error(`Snapshot did not capture object ${oid}`);
	return object;
}

/** File bytes from the captured working tree; gitlinks are structural leaves. */
export function snapshotContent(
	snapshot: RepositorySnapshot,
	path: string,
): Uint8Array | null {
	const entry = snapshot.files.get(path);
	if (entry === undefined || entry.mode === '160000') return null;
	return snapshotObject(snapshot, entry.oid).bytes;
}
