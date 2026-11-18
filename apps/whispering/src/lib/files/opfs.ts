/**
 * `Files` in a browser: the directory `dir` in the Origin Private File
 * System, in the same layout as the desktop's folder.
 *
 * `write` writes through `createWritable()`, whose changes reach the file
 * only when the stream closes, so a reader sees the old bytes or the new
 * ones. A write that fails aborts its stream and leaves the file as it was.
 * `readMany` reads a few files at a time. The build runs where a page has
 * `createWritable()`: Chrome, Firefox, and Safari 26 or later (ADR-0894).
 */
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	checkPath,
	type Entry,
	type Files,
	type FilesError,
	failed,
	isPlainName,
} from './files.js';

/** At most this many reads are out at once in `readMany`. */
const READS_AT_ONCE = 8;

/** A DOMException's name, or null. */
const nameOf = (cause: unknown) =>
	cause instanceof DOMException ? cause.name : null;
const isMissing = (cause: unknown) =>
	nameOf(cause) === 'NotFoundError' || nameOf(cause) === 'TypeMismatchError';

type Directory = FileSystemDirectoryHandle & {
	values(): AsyncIterable<FileSystemHandle>;
};

export function opfsFiles(dir: string): Files {
	const base = checkPath(dir, { directory: true });

	/** The directory at `segments` below the base, made when `create`; null when it is not there. */
	async function directoryAt(
		segments: readonly string[],
		create: boolean,
	): Promise<Directory | null> {
		if (base.error !== null) throw base.error;
		let handle = (await navigator.storage.getDirectory()) as Directory;
		for (const segment of [...base.data, ...segments]) {
			try {
				handle = (await handle.getDirectoryHandle(segment, {
					create,
				})) as Directory;
			} catch (cause) {
				if (!create && isMissing(cause)) return null;
				throw cause;
			}
		}
		return handle;
	}

	/** The parent directory's segments and the file's name. */
	function split(
		path: string,
	): Result<{ parent: string[]; name: string }, FilesError> {
		const checked = checkPath(path);
		if (checked.error !== null) return checked;
		const segments = checked.data;
		const name = segments.pop() as string;
		return Ok({ parent: segments, name });
	}

	/** Run `work`, answering what failed as `Io`. */
	async function io<T>(
		what: string,
		work: () => Promise<T>,
	): Promise<Result<T, FilesError>> {
		try {
			return Ok(await work());
		} catch (cause) {
			return failed(`Could not ${what}: ${extractErrorMessage(cause)}`);
		}
	}

	async function readOne(parent: string[], name: string) {
		const directory = await directoryAt(parent, false);
		if (directory === null) return null;
		try {
			const handle = await directory.getFileHandle(name);
			return new Uint8Array(await (await handle.getFile()).arrayBuffer());
		} catch (cause) {
			if (isMissing(cause)) return null;
			throw cause;
		}
	}

	return {
		async read(path) {
			const at = split(path);
			if (at.error !== null) return at;
			return io(`read ${path}`, () => readOne(at.data.parent, at.data.name));
		},
		async readMany(paths) {
			const all: { path: string; parent: string[]; name: string }[] = [];
			for (const path of paths) {
				const at = split(path);
				if (at.error !== null) return at;
				all.push({ path, ...at.data });
			}
			return io('read the notes', async () => {
				const read = new Map<string, Uint8Array>();
				let next = 0;
				async function reader() {
					while (next < all.length) {
						const { path, parent, name } = all[next++] as (typeof all)[number];
						const bytes = await readOne(parent, name);
						if (bytes !== null) read.set(path, bytes);
					}
				}
				await Promise.all(
					Array.from({ length: Math.min(READS_AT_ONCE, all.length) }, reader),
				);
				// In the order asked, as the desktop answers.
				return new Map(
					all.flatMap(({ path }) => {
						const bytes = read.get(path);
						return bytes === undefined ? [] : [[path, bytes] as const];
					}),
				);
			});
		},
		async write(path, bytes) {
			const at = split(path);
			if (at.error !== null) return at;
			return io(`write ${path}`, async () => {
				const parent = (await directoryAt(at.data.parent, true)) as Directory;
				const handle = await parent.getFileHandle(at.data.name, {
					create: true,
				});
				const stream = await handle.createWritable();
				try {
					await stream.write(bytes as Uint8Array<ArrayBuffer>);
					await stream.close();
				} catch (cause) {
					await stream.abort().catch(() => {});
					throw cause;
				}
				return undefined;
			});
		},
		async list(dir) {
			const checked = checkPath(dir, { directory: true });
			if (checked.error !== null) return checked;
			return io(`list ${dir || 'the folder'}`, async () => {
				const handle = await directoryAt(checked.data, false);
				if (handle === null) return [];
				const entries: Entry[] = [];
				for await (const entry of handle.values()) {
					if (entry.kind !== 'file' || !isPlainName(entry.name)) continue;
					const file = await (entry as FileSystemFileHandle).getFile();
					entries.push({
						name: entry.name,
						size: file.size,
						modifiedMs: file.lastModified,
					});
				}
				return entries.sort((a, b) => (a.name < b.name ? -1 : 1));
			});
		},
		async remove(path) {
			const at = split(path);
			if (at.error !== null) return at;
			return io(`remove ${path}`, async () => {
				const parent = await directoryAt(at.data.parent, false);
				if (parent === null) return undefined;
				try {
					await parent.removeEntry(at.data.name);
				} catch (cause) {
					if (!isMissing(cause)) throw cause;
				}
				return undefined;
			});
		},
	};
}
