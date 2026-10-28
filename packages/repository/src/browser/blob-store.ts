/**
 * Blob bytes on this device, in the origin's private storage beside the
 * repository's SQLite pool: `.epicenter/<repository>.blobs/<oid>` holds an
 * object's bytes exactly, and `<oid>.type` its media type. The pool's own
 * directory, `.epicenter/<repository>`, belongs to the VFS alone, which
 * deletes it whole when the pool is removed. Content
 * addressing needs no index: an object exists exactly when a file under
 * its oid does.
 *
 * Each file is written under a temporary name through a sync access handle,
 * flushed, then moved onto its final name, and the type is moved into place
 * before the bytes. A worker that dies mid-put (a tab closed for good kills
 * its worker) leaves at most a stray temporary file, which nothing reads.
 * Sync access handles exist only in dedicated workers, so the store runs in
 * the owning tab's worker.
 */
import { sha256 } from '../hash.js';
import type { BlobStore } from '../engine/ports.js';

/** An LFS oid, lowercase hex SHA-256; anything else names no object here. */
const OID = /^[0-9a-f]{64}$/;

/**
 * The store's URLs are its own: one per object, created on the first `url`
 * and shared by every later caller, so a caller never revokes one. `close`
 * revokes them all, and a browser revokes them anyway when the worker that
 * created them ends, so a URL lives as long as the open repository that
 * answered it.
 */
export type OpfsBlobStore = BlobStore & {
	/** Wait for every put in progress, then revoke every URL this store made. */
	close(): Promise<void>;
};

/** The blob directory of the repository `name`, a sibling of its SQLite pool, created if missing. */
export async function opfsBlobDirectory(name: string): Promise<FileSystemDirectoryHandle> {
	const root = await navigator.storage.getDirectory();
	const epicenter = await root.getDirectoryHandle('.epicenter', { create: true });
	return epicenter.getDirectoryHandle(`${name}.blobs`, { create: true });
}

/**
 * What a file handle offers in a dedicated worker. The package builds against
 * the DOM library, which leaves these out; Chromium, WebKit and Firefox all
 * have both in a worker, and WebKit's `move` needs the directory too.
 */
type WorkerFileHandle = FileSystemFileHandle & {
	createSyncAccessHandle(): Promise<{
		truncate(size: number): void;
		write(bytes: Uint8Array, options: { at: number }): number;
		flush(): void;
		close(): void;
	}>;
	move(to: FileSystemDirectoryHandle, name: string): Promise<void>;
};

const isNotFound = (cause: unknown) => cause instanceof DOMException && cause.name === 'NotFoundError';

/** Store blob bytes as files in `directory`. */
export function createOpfsBlobStore(directory: FileSystemDirectoryHandle): OpfsBlobStore {
	/** Puts in progress by oid: a second put of the same bytes joins the first. */
	const putting = new Map<string, Promise<void>>();
	const urls = new Map<string, string>();

	/** The file named `name`, or null when there is none. */
	async function fileNamed(name: string): Promise<File | null> {
		try {
			return await (await directory.getFileHandle(name)).getFile();
		} catch (cause) {
			if (isNotFound(cause)) return null;
			throw cause;
		}
	}

	/** Write `bytes` under a temporary name, then move the file onto `name`. */
	async function writeFile(name: string, bytes: Uint8Array) {
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

	async function store(oid: string, bytes: Uint8Array, type: string) {
		// Already stored: the bytes under an oid never change, and leaving the
		// file alone keeps every URL made from it readable.
		if ((await fileNamed(oid)) !== null) return;
		await writeFile(`${oid}.type`, new TextEncoder().encode(type));
		await writeFile(oid, bytes);
	}

	return {
		async put(oid, bytes, type) {
			if ((await sha256(bytes)) !== oid) throw new Error(`The bytes do not hash to ${oid}`);
			const running = putting.get(oid);
			if (running !== undefined) return running;
			const stored = store(oid, bytes, type).finally(() => putting.delete(oid));
			putting.set(oid, stored);
			return stored;
		},
		async get(oid) {
			if (!OID.test(oid)) return null;
			const file = await fileNamed(oid);
			return file === null ? null : new Uint8Array(await file.arrayBuffer());
		},
		async url(oid) {
			if (!OID.test(oid)) return null;
			const made = urls.get(oid);
			if (made !== undefined) return made;
			const file = await fileNamed(oid);
			if (file === null) return null;
			const type = (await (await fileNamed(`${oid}.type`))?.text()) ?? '';
			// Another call may have made one while this one read.
			const raced = urls.get(oid);
			if (raced !== undefined) return raced;
			const url = URL.createObjectURL(file.slice(0, file.size, type));
			urls.set(oid, url);
			return url;
		},
		async close() {
			await Promise.allSettled(putting.values());
			for (const url of urls.values()) URL.revokeObjectURL(url);
			urls.clear();
		},
	};
}
