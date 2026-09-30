/**
 * IndexedDB storage for one browser folder.
 *
 * One database holds the portable files (`inventory` and `contents`, keyed by
 * literal path), directories the shell created (`directories`), and private
 * Git state (`git`, keyed by its private path). Git never writes portable
 * paths; the portable file boundary never writes Git state, except when an
 * incoming fast-forward publishes both in one transaction.
 *
 * Bytes are hashed before a transaction opens. Inside a transaction there are
 * only IndexedDB requests, so the stored-version comparison and the write
 * happen atomically.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type {
	CapturedFiles,
	FileBoundary,
	FileChange,
	FileListing,
	FileRead,
} from './boundary.js';
import { FileError } from './errors.js';
import { ancestors, isPortablePath, pathProblem } from './paths.js';
import { type FileVersion, satisfies } from './version.js';

export type IndexedDbEnvironment = {
	readonly indexedDB: IDBFactory;
	readonly IDBKeyRange: typeof IDBKeyRange;
};

/** Metadata beside each file's bytes. `mtimeMs` and `ino` change on every write. */
export type InventoryRecord = {
	readonly sha256: string;
	readonly size: number;
	readonly mtimeMs: number;
	readonly ino: number;
};

export const STORES = {
	inventory: 'inventory',
	contents: 'contents',
	directories: 'directories',
	git: 'git',
} as const;

export async function openFolderDatabase(
	name: string,
	environment: IndexedDbEnvironment,
): Promise<IDBDatabase> {
	const opening = environment.indexedDB.open(name, 1);
	opening.onupgradeneeded = () => {
		for (const store of Object.values(STORES))
			if (!opening.result.objectStoreNames.contains(store))
				opening.result.createObjectStore(store);
	};
	const db = await request(opening);
	db.onversionchange = () => db.close();
	return db;
}

export function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		value.onsuccess = () => resolve(value.result);
		value.onerror = () => reject(value.error);
	});
}

export function completion(tx: IDBTransaction): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () =>
			reject(tx.error ?? new Error('The storage transaction aborted'));
		tx.onerror = () => reject(tx.error);
	});
}

/** A key range covering `prefix` and every key that starts with it. */
export function prefixRange(
	environment: IndexedDbEnvironment,
	prefix: string,
): IDBKeyRange {
	return environment.IDBKeyRange.bound(prefix, `${prefix}￿`);
}

/** Refusal raised inside a transaction body; the transaction is aborted. */
export class Refusal {
	constructor(readonly error: FileError) {}
}

/**
 * Run `body` in one readwrite transaction. A thrown `Refusal` aborts it and
 * becomes the returned error; nothing it wrote remains.
 */
export async function writeTransaction<T>(
	db: IDBDatabase,
	stores: readonly string[],
	body: (tx: IDBTransaction) => Promise<T>,
): Promise<Result<T, FileError>> {
	let tx: IDBTransaction;
	try {
		tx = db.transaction(stores as string[], 'readwrite', {
			durability: 'strict',
		});
	} catch (cause) {
		return FileError.Io({ path: '', operation: 'open a transaction', cause });
	}
	const done = completion(tx);
	let value: T;
	try {
		value = await body(tx);
	} catch (cause) {
		try {
			tx.abort();
		} catch {
			// Already finished or aborted.
		}
		await done.catch(() => {});
		if (cause instanceof Refusal) return Err(cause.error);
		return FileError.Io({ path: '', operation: 'write', cause });
	}
	try {
		await done;
	} catch (cause) {
		return FileError.Io({ path: '', operation: 'commit a transaction', cause });
	}
	return Ok(value);
}

let lastWriteTime = 0;
/** Strictly increasing write stamp so Git's stat comparison notices every rewrite. */
export function writeStamp(): Pick<InventoryRecord, 'mtimeMs' | 'ino'> {
	lastWriteTime = Math.max(Date.now(), lastWriteTime + 1);
	return {
		mtimeMs: lastWriteTime,
		ino: crypto.getRandomValues(new Uint32Array(1))[0]!,
	};
}

function toVersion(
	record: InventoryRecord | undefined,
): FileVersion | undefined {
	return record === undefined
		? undefined
		: { sha256: record.sha256, size: record.size };
}

/**
 * Apply file changes inside an already open transaction over the inventory,
 * contents, and directories stores. Throws `Refusal` on a failed condition.
 */
export async function applyInTransaction(
	tx: IDBTransaction,
	environment: IndexedDbEnvironment,
	changes: readonly FileChange[],
): Promise<void> {
	const inventory = tx.objectStore(STORES.inventory);
	const contents = tx.objectStore(STORES.contents);
	const directories = tx.objectStore(STORES.directories);

	async function current(path: string) {
		return (await request(inventory.get(path))) as InventoryRecord | undefined;
	}
	async function requireWritable(path: string) {
		const nested = await request(
			inventory.count(prefixRange(environment, `${path}/`)),
		);
		const directory = await request(directories.get(path));
		if (nested > 0 || directory !== undefined)
			throw new Refusal(FileError.NotAFile({ path }).error);
		for (const parent of ancestors(path))
			if ((await current(parent)) !== undefined)
				throw new Refusal(FileError.NotADirectory({ path: parent }).error);
	}
	function check(
		path: string,
		found: InventoryRecord | undefined,
		expected: FileChange['expected'],
	) {
		if (!satisfies(toVersion(found), expected))
			throw new Refusal(
				FileError.Conflict({ path, expected, actual: toVersion(found) }).error,
			);
	}

	for (const change of changes) {
		if (change.kind === 'write') {
			const found = await current(change.path);
			check(change.path, found, change.expected);
			if (found === undefined) await requireWritable(change.path);
			const record: InventoryRecord = {
				sha256: change.version.sha256,
				size: change.version.size,
				...writeStamp(),
			};
			inventory.put(record, change.path);
			contents.put(change.bytes, change.path);
		} else if (change.kind === 'remove') {
			const found = await current(change.path);
			if (found === undefined && change.expected !== 'absent')
				throw new Refusal(FileError.NotFound({ path: change.path }).error);
			check(change.path, found, change.expected);
			inventory.delete(change.path);
			contents.delete(change.path);
		} else {
			const found = await current(change.from);
			if (found === undefined)
				throw new Refusal(FileError.NotFound({ path: change.from }).error);
			check(change.from, found, change.expected);
			const destination = await current(change.to);
			if (destination !== undefined)
				throw new Refusal(
					FileError.Conflict({
						path: change.to,
						expected: 'absent',
						actual: toVersion(destination),
					}).error,
				);
			await requireWritable(change.to);
			const bytes = (await request(contents.get(change.from))) as Uint8Array;
			inventory.put({ ...found, ...writeStamp() }, change.to);
			contents.put(bytes, change.to);
			inventory.delete(change.from);
			contents.delete(change.from);
		}
	}
}

function invalid(path: string): Result<never, FileError> | undefined {
	const problem = pathProblem(path);
	return problem === undefined
		? undefined
		: FileError.InvalidPath({ path, reason: problem });
}

export function createBrowserFileBoundary(
	db: IDBDatabase,
	environment: IndexedDbEnvironment,
): FileBoundary {
	async function readTransaction<T>(
		stores: string[],
		body: (tx: IDBTransaction) => Promise<T>,
		path: string,
	): Promise<Result<T, FileError>> {
		try {
			const tx = db.transaction(stores, 'readonly');
			return Ok(await body(tx));
		} catch (cause) {
			if (cause instanceof Refusal) return Err(cause.error);
			return FileError.Io({ path, operation: 'read', cause });
		}
	}

	async function readOne(
		tx: IDBTransaction,
		path: string,
	): Promise<Result<FileRead, FileError>> {
		const record = (await request(
			tx.objectStore(STORES.inventory).get(path),
		)) as InventoryRecord | undefined;
		if (record === undefined) {
			const nested = await request(
				tx
					.objectStore(STORES.inventory)
					.count(prefixRange(environment, `${path}/`)),
			);
			const directory = await request(
				tx.objectStore(STORES.directories).get(path),
			);
			if (nested > 0 || directory !== undefined)
				return FileError.NotAFile({ path });
			return FileError.NotFound({ path });
		}
		const bytes = (await request(tx.objectStore(STORES.contents).get(path))) as
			| Uint8Array
			| undefined;
		if (bytes === undefined || bytes.byteLength !== record.size)
			return FileError.Io({
				path,
				operation: 'read',
				cause: new Error(
					'Stored bytes are missing or do not match their recorded size',
				),
			});
		return Ok({ bytes, version: { sha256: record.sha256, size: record.size } });
	}

	return {
		async list() {
			return readTransaction(
				[STORES.inventory, STORES.directories],
				async (tx) => {
					const keys = (await request(
						tx.objectStore(STORES.inventory).getAllKeys(),
					)) as string[];
					const records = (await request(
						tx.objectStore(STORES.inventory).getAll(),
					)) as InventoryRecord[];
					const explicit = (await request(
						tx.objectStore(STORES.directories).getAllKeys(),
					)) as string[];
					const directories = new Set(explicit);
					for (const path of keys)
						for (const parent of ancestors(path)) directories.add(parent);
					const listing: FileListing = {
						files: keys.map((path, index) => ({
							path,
							size: records[index]!.size,
						})),
						directories: [...directories].sort(),
					};
					return listing;
				},
				'',
			);
		},
		async children(directory) {
			if (directory !== '') {
				const refused = invalid(directory);
				if (refused) return refused;
			}
			const prefix = directory === '' ? '' : `${directory}/`;
			return readTransaction(
				[STORES.inventory, STORES.directories],
				async (tx) => {
					const range =
						prefix === '' ? undefined : prefixRange(environment, prefix);
					const fileKeys = (await request(
						tx.objectStore(STORES.inventory).getAllKeys(range),
					)) as string[];
					const directoryKeys = (await request(
						tx.objectStore(STORES.directories).getAllKeys(range),
					)) as string[];
					// An empty directory has no descendants; its own explicit record
					// is what makes it exist.
					const explicit =
						directory === ''
							? undefined
							: await request(
									tx.objectStore(STORES.directories).get(directory),
								);
					if (
						directory !== '' &&
						explicit === undefined &&
						fileKeys.length === 0 &&
						directoryKeys.length === 0
					) {
						const asFile = await request(
							tx.objectStore(STORES.inventory).get(directory),
						);
						throw new Refusal(
							asFile === undefined
								? FileError.NotFound({ path: directory }).error
								: FileError.NotADirectory({ path: directory }).error,
						);
					}
					const files = new Set<string>();
					const directories = new Set<string>();
					for (const key of fileKeys) {
						const rest = key.slice(prefix.length);
						const slash = rest.indexOf('/');
						if (slash < 0) files.add(rest);
						else directories.add(rest.slice(0, slash));
					}
					for (const key of directoryKeys) {
						const rest = key.slice(prefix.length);
						if (rest === '') continue;
						directories.add(rest.split('/')[0]!);
					}
					return {
						files: [...files].sort(),
						directories: [...directories].sort(),
					};
				},
				directory,
			);
		},
		async read(path) {
			const refused = invalid(path);
			if (refused) return refused;
			const result = await readTransaction(
				[STORES.inventory, STORES.contents, STORES.directories],
				(tx) => readOne(tx, path),
				path,
			);
			return result.error ? result : result.data;
		},
		async readMany(paths) {
			return readTransaction(
				[STORES.inventory, STORES.contents, STORES.directories],
				async (tx) => {
					const results = new Map<string, Result<FileRead, FileError>>();
					for (const path of paths) {
						const refused = invalid(path);
						results.set(path, refused ?? (await readOne(tx, path)));
					}
					return results;
				},
				'',
			);
		},
		async open(path) {
			const read = await this.read(path);
			if (read.error) return read;
			return Ok(new Blob([read.data.bytes.slice() as Uint8Array<ArrayBuffer>]));
		},
		async apply(changes) {
			for (const change of changes) {
				const paths =
					change.kind === 'move' ? [change.from, change.to] : [change.path];
				for (const path of paths) {
					const refused = invalid(path);
					if (refused) return refused;
				}
			}
			const result = await writeTransaction(
				db,
				[STORES.inventory, STORES.contents, STORES.directories],
				(tx) => applyInTransaction(tx, environment, changes),
			);
			return result.error ? result : Ok(undefined);
		},
		async mkdir(path) {
			const refused = invalid(path);
			if (refused) return refused;
			return writeTransaction(
				db,
				[STORES.inventory, STORES.directories],
				async (tx) => {
					const inventory = tx.objectStore(STORES.inventory);
					for (const candidate of [...ancestors(path), path])
						if ((await request(inventory.get(candidate))) !== undefined)
							throw new Refusal(
								FileError.NotADirectory({ path: candidate }).error,
							);
					for (const candidate of [...ancestors(path), path])
						tx.objectStore(STORES.directories).put(true, candidate);
					return undefined;
				},
			);
		},
		async rmdir(path) {
			const refused = invalid(path);
			if (refused) return refused;
			return writeTransaction(
				db,
				[STORES.inventory, STORES.directories],
				async (tx) => {
					const nestedFiles = await request(
						tx
							.objectStore(STORES.inventory)
							.count(prefixRange(environment, `${path}/`)),
					);
					const nestedDirectories = await request(
						tx
							.objectStore(STORES.directories)
							.count(prefixRange(environment, `${path}/`)),
					);
					if (nestedFiles > 0 || nestedDirectories > 0)
						throw new Refusal(FileError.DirectoryNotEmpty({ path }).error);
					const exists = await request(
						tx.objectStore(STORES.directories).get(path),
					);
					if (exists === undefined) {
						const file = await request(
							tx.objectStore(STORES.inventory).get(path),
						);
						throw new Refusal(
							file === undefined
								? FileError.NotFound({ path }).error
								: FileError.NotADirectory({ path }).error,
						);
					}
					tx.objectStore(STORES.directories).delete(path);
					return undefined;
				},
			);
		},
		async capture() {
			return readTransaction(
				[STORES.inventory, STORES.contents],
				async (tx) => {
					const keys = (await request(
						tx.objectStore(STORES.contents).getAllKeys(),
					)) as string[];
					const values = (await request(
						tx.objectStore(STORES.contents).getAll(),
					)) as Uint8Array[];
					const files = new Map<string, Uint8Array>();
					keys.forEach((path, index) => {
						if (isPortablePath(path)) files.set(path, values[index]!);
					});
					const captured: CapturedFiles = { files, unreadable: [] };
					return captured;
				},
				'',
			);
		},
	};
}
