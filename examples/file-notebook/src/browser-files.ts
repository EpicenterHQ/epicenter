import {
	type AccountFiles,
	attachmentFor,
	checkedPath,
	type FileSnapshot,
	publicationConflict,
} from './files.js';

type StoredFile = { path: string; bytes: Uint8Array; revision: string };
export type BrowserAccountFiles = AccountFiles & {
	applyIncoming(
		expected: { path: string; revision: string }[],
		incoming: { path: string; bytes: Uint8Array }[],
	): Promise<void>;
};

function request<T>(operation: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		operation.onsuccess = () => resolve(operation.result);
		operation.onerror = () => reject(operation.error);
	});
}

function completed(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(transaction.error ?? new Error('File transaction aborted'));
		transaction.onerror = () =>
			reject(transaction.error ?? new Error('File transaction failed'));
	});
}

export async function openBrowserFiles(
	name: string,
): Promise<BrowserAccountFiles> {
	const opening = indexedDB.open(`epicenter-file-notebook-${name}`, 1);
	opening.onupgradeneeded = () =>
		opening.result.createObjectStore('files', { keyPath: 'path' });
	const database = await request(opening);
	const listeners = new Set<() => void>();
	const channel =
		typeof BroadcastChannel === 'undefined'
			? undefined
			: new BroadcastChannel(`epicenter-file-notebook-${name}`);
	const changed = () => {
		for (const listener of listeners) listener();
	};
	if (channel) channel.onmessage = changed;
	const publish = () => {
		changed();
		channel?.postMessage('changed');
	};
	const snapshotOf = (stored: StoredFile): FileSnapshot => ({
		path: stored.path,
		bytes: new Uint8Array(stored.bytes),
		revision: stored.revision,
	});
	const put = (path: string, bytes: Uint8Array): StoredFile => ({
		path,
		bytes: new Uint8Array(bytes),
		revision: crypto.randomUUID(),
	});
	const sorted = (left: string, right: string) =>
		left < right ? -1 : left > right ? 1 : 0;

	return {
		async list() {
			const transaction = database.transaction('files');
			const paths = await request(
				transaction.objectStore('files').getAllKeys(),
			);
			await completed(transaction);
			return paths.map(String).sort(sorted);
		},
		async read(path) {
			checkedPath(path);
			const transaction = database.transaction('files');
			const stored = await request<StoredFile | undefined>(
				transaction.objectStore('files').get(path),
			);
			await completed(transaction);
			return stored && snapshotOf(stored);
		},
		async snapshot() {
			const transaction = database.transaction('files');
			const stored = await request<StoredFile[]>(
				transaction.objectStore('files').getAll(),
			);
			await completed(transaction);
			return stored
				.map(snapshotOf)
				.sort((left, right) => sorted(left.path, right.path));
		},
		async create(path, bytes) {
			checkedPath(path);
			const file = put(path, bytes);
			const transaction = database.transaction('files', 'readwrite', {
				durability: 'strict',
			});
			const store = transaction.objectStore('files');
			const existing = (await request(store.getAllKeys())).map(String);
			const conflict = publicationConflict(existing, [path]);
			if (conflict) {
				transaction.abort();
				throw new Error(conflict);
			}
			store.add(file);
			await completed(transaction);
			publish();
			return snapshotOf(file);
		},
		async replace(source, bytes) {
			checkedPath(source.path);
			const file = put(source.path, bytes);
			const transaction = database.transaction('files', 'readwrite', {
				durability: 'strict',
			});
			const store = transaction.objectStore('files');
			const current = await request<StoredFile | undefined>(
				store.get(source.path),
			);
			if (current?.revision !== source.revision) {
				transaction.abort();
				throw new Error(`Changed since read: ${source.path}`);
			}
			store.put(file);
			await completed(transaction);
			publish();
			return snapshotOf(file);
		},
		async publishRow(rowPath, row, attachment) {
			checkedPath(rowPath);
			if (
				attachment &&
				attachmentFor(rowPath, attachment.path.split('.').at(-1) ?? '') !==
					attachment.path
			) {
				throw new Error('Invalid attachment name');
			}
			const transaction = database.transaction('files', 'readwrite', {
				durability: 'strict',
			});
			const store = transaction.objectStore('files');
			const paths = (await request(store.getAllKeys())).map(String);
			const conflict = publicationConflict(
				paths,
				attachment ? [attachment.path, rowPath] : [rowPath],
				rowPath,
			);
			if (conflict) {
				transaction.abort();
				throw new Error(conflict);
			}
			if (attachment) store.add(put(attachment.path, attachment.bytes));
			store.add(put(rowPath, row));
			await completed(transaction);
			publish();
		},
		async applyIncoming(expected, incoming) {
			const newPaths = incoming.map((file) => file.path);
			const conflict = publicationConflict([], newPaths);
			if (conflict) throw new Error(conflict);
			if (expected.some((file) => !newPaths.includes(file.path)))
				throw new Error(
					'Incoming deletion is unsupported by this demo; current files were kept',
				);
			const prepared = incoming.map((file) =>
				put(checkedPath(file.path), file.bytes),
			);
			const transaction = database.transaction('files', 'readwrite', {
				durability: 'strict',
			});
			const store = transaction.objectStore('files');
			const current = await request<StoredFile[]>(store.getAll());
			const byPath = new Map(
				expected.map((file) => [file.path, file.revision]),
			);
			if (
				current.length !== expected.length ||
				current.some((file) => byPath.get(file.path) !== file.revision)
			) {
				transaction.abort();
				throw new Error('Current files changed during Pull');
			}
			for (const file of prepared) store.put(file);
			await completed(transaction);
			publish();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
