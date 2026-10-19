/**
 * The caller-facing `Folder` over an engine, the same on every host: local
 * save status, the operations `close` waits for, and the error a closed
 * handle throws. The browser's default local folder (`local-folder.ts`) and
 * the native directory folder (`native/engine.ts`) each supply the engine.
 */
import type { TSchema as Schema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import type {
	Folder,
	FolderChange,
	FolderFiles,
	FolderStatus,
	FolderTable,
	SaveError,
} from './folder.js';
import { callObserver } from './observer.js';

/** What an engine gives the handle: its files, tables, changes, and release. */
export type FolderEngine = {
	readonly files: FolderFiles;
	readonly tables: Record<string, FolderTable>;
	subscribe(listener: (change: FolderChange) => void): () => void;
	/** Release listeners and storage; the handle calls it once, after started work settled. */
	close(): void;
};

/** The handle over `engine`, typed by `tables`. */
export function folderHandle<const TTables extends Record<string, Schema>>(
	engine: FolderEngine,
	tables: TTables,
): Folder<TTables> {
	let closing: Promise<void> | undefined;
	const inflight = new Set<Promise<unknown>>();
	let saves = 0;
	let status: FolderStatus = {
		saving: false,
		storageFailure: null,
	};
	const statusListeners = new Set<(status: FolderStatus) => void>();

	function assertOpen() {
		if (closing !== undefined) throw new Error('The folder is closed');
	}

	/**
	 * `status` changes only when a save starts or ends. A save that succeeded,
	 * a no-op retry included, clears the last storage failure.
	 */
	function publishStatus(storageFailure = status.storageFailure) {
		const next: FolderStatus = {
			saving: saves > 0,
			storageFailure,
		};
		if (
			next.saving === status.saving &&
			next.storageFailure === status.storageFailure
		)
			return;
		status = next;
		for (const listener of [...statusListeners])
			callObserver('status listener', listener, next);
	}

	/** Track the operation so `close` can wait for it. */
	function track<T>(run: () => Promise<T>): Promise<T> {
		assertOpen();
		let resolve!: (value: T) => void;
		let reject!: (reason: unknown) => void;
		const operation = new Promise<T>((accepted, refused) => {
			resolve = accepted;
			reject = refused;
		});
		inflight.add(operation);
		const done = () => inflight.delete(operation);
		operation.then(done, done);
		// `run` can notify a status observer synchronously. That observer may
		// close the folder, so close must already see this operation.
		try {
			Promise.resolve(run()).then(resolve, reject);
		} catch (cause) {
			reject(cause);
		}
		return operation;
	}

	function save<T>(work: () => Promise<Result<T, SaveError>>) {
		return track(async () => {
			saves++;
			publishStatus();
			let result: Result<T, SaveError>;
			try {
				result = await work();
			} catch (cause) {
				saves--;
				publishStatus();
				throw cause;
			}
			saves--;
			publishStatus(
				result.error === null
					? null
					: result.error.name === 'StorageFailed'
						? result.error
						: status.storageFailure,
			);
			return result;
		});
	}

	function wrapFiles(files: FolderFiles): FolderFiles {
		return {
			list: (prefix) => track(() => files.list(prefix)),
			read: (path) => track(() => files.read(path)),
			write: (path, from, content) =>
				save(() => files.write(path, from, content)),
			delete: (path, from) => save(() => files.delete(path, from)),
		};
	}

	function wrapTable(table: FolderTable): FolderTable {
		return {
			list: () => track(() => table.list()),
			get: (id) => track(() => table.get(id)),
			set: (id, from, change) => save(() => table.set(id, from, change)),
			delete: (id, from) => save(() => table.delete(id, from)),
		};
	}

	const folder: Folder<Record<string, Schema>> = {
		files: wrapFiles(engine.files),
		tables: Object.fromEntries(
			Object.keys(tables).map((name) => [
				name,
				wrapTable(engine.tables[name] as FolderTable),
			]),
		),
		onChange(listener) {
			assertOpen();
			return engine.subscribe(listener);
		},
		get status() {
			return status;
		},
		onStatusChange(listener) {
			assertOpen();
			statusListeners.add(listener);
			return () => {
				statusListeners.delete(listener);
			};
		},
		close() {
			closing ??= (async () => {
				await Promise.allSettled([...inflight]);
				statusListeners.clear();
				engine.close();
			})();
			return closing;
		},
	};
	return folder as unknown as Folder<TTables>;
}
