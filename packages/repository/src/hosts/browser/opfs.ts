/**
 * What the package needs of the origin private file system beyond the DOM
 * library's declarations, which leave out a directory's entries and a file's
 * sync access handle and move. Chromium, WebKit and Firefox have all three;
 * sync access handles exist only in dedicated workers.
 */

/** A file handle in a dedicated worker. */
export type WorkerFileHandle = FileSystemFileHandle & {
	createSyncAccessHandle(): Promise<SyncAccessHandle>;
	/** WebKit's `move` needs the directory too, so it is always given. */
	move(to: FileSystemDirectoryHandle, name: string): Promise<void>;
};

export type SyncAccessHandle = {
	truncate(size: number): void;
	write(bytes: Uint8Array, options: { at: number }): number;
	getSize(): number;
	flush(): void;
	close(): void;
};

/** The names in `directory`, with whether each is a file or a directory. */
export async function entriesOf(directory: FileSystemDirectoryHandle): Promise<[string, FileSystemHandle['kind']][]> {
	const found: [string, FileSystemHandle['kind']][] = [];
	for await (const [name, handle] of (directory as FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries())
		found.push([name, handle.kind]);
	return found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export const isNotFound = (cause: unknown) => cause instanceof DOMException && cause.name === 'NotFoundError';

/** The directory `name` in `parent`, or null when there is none. */
export async function directoryIn(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | null> {
	try {
		return await parent.getDirectoryHandle(name);
	} catch (cause) {
		if (isNotFound(cause)) return null;
		throw cause;
	}
}

/** The file `name` in `directory`, or null when there is none. */
export async function fileIn(directory: FileSystemDirectoryHandle, name: string): Promise<File | null> {
	try {
		return await (await directory.getFileHandle(name)).getFile();
	} catch (cause) {
		if (isNotFound(cause)) return null;
		throw cause;
	}
}

/**
 * Write `bytes` to `name` in `directory` whole or not at all: under a
 * temporary name through a sync access handle, flushed, then moved onto
 * `name`. A worker killed midway leaves at most a stray temporary file. In a
 * dedicated worker only.
 */
export async function writeWhole(directory: FileSystemDirectoryHandle, name: string, bytes: Uint8Array) {
	const temporary = `${name}.${crypto.randomUUID()}.tmp`;
	const handle = (await directory.getFileHandle(temporary, { create: true })) as WorkerFileHandle;
	try {
		const access = await handle.createSyncAccessHandle();
		try {
			access.truncate(0);
			if (access.write(bytes, { at: 0 }) !== bytes.length) throw new Error(`The write to '${temporary}' was short`);
			access.flush();
		} finally {
			access.close();
		}
		await handle.move(directory, name);
	} catch (cause) {
		await directory.removeEntry(temporary).catch(() => {});
		throw cause;
	}
}
