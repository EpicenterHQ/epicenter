/**
 * `Files` in a browser: the page's Origin Private File System, in the same
 * layout as the desktop's folder.
 *
 * `write` writes through `createWritable()`, whose changes reach the file
 * only when the stream closes, so a reader sees the old contents or the new.
 * A write that fails aborts its stream and leaves the file as it was. This
 * needs Chrome, Firefox, or Safari 26 or later.
 *
 * `url` answers an object URL for the file. The browser reads it from disk
 * as the player asks, so long audio is never held in the page. One URL is
 * kept per path, so a list that renders again makes no new ones, and
 * `remove` releases it.
 */
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	checkPath,
	type Files,
	type FilesError,
	failed,
	isPlainName,
	toBytes,
} from './files';

/** At most this many reads are out at once in `readMany`. */
const READS_AT_ONCE = 8;

type Directory = FileSystemDirectoryHandle & {
	values(): AsyncIterable<FileSystemHandle>;
};

const isMissing = (cause: unknown) =>
	cause instanceof DOMException &&
	(cause.name === 'NotFoundError' || cause.name === 'TypeMismatchError');

/** The directory at `segments`, made when `create`; null when it is not there. */
async function directoryAt(
	segments: readonly string[],
	create: boolean,
): Promise<Directory | null> {
	let handle = (await navigator.storage.getDirectory()) as Directory;
	for (const segment of segments) {
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

/** The file at `segments`, or null when it is not there. */
async function fileAt(segments: readonly string[]): Promise<File | null> {
	const directory = await directoryAt(segments.slice(0, -1), false);
	if (!directory) return null;
	try {
		const handle = await directory.getFileHandle(segments.at(-1) as string);
		return await handle.getFile();
	} catch (cause) {
		if (isMissing(cause)) return null;
		throw cause;
	}
}

/** Run `work` on `path` once it is checked, answering what failed as `Io`. */
async function io<T>(
	what: string,
	path: string,
	work: (segments: string[]) => Promise<T>,
	{ directory = false } = {},
): Promise<Result<T, FilesError>> {
	const checked = checkPath(path, { directory });
	if (checked.error) return checked;
	try {
		return Ok(await work(checked.data));
	} catch (cause) {
		return failed(
			`Could not ${what} ${path || 'the folder'}: ${extractErrorMessage(cause)}`,
		);
	}
}

export function opfsFiles(): Files {
	const urls = new Map<string, string>();
	// Without this, a browser low on space may clear these files to make
	// room. It may still say no; the files then stay as they would without it.
	void navigator.storage.persist();

	return {
		keptIn: 'this browser',
		list: (dir) =>
			io(
				'list',
				dir,
				async (segments) => {
					const directory = await directoryAt(segments, false);
					if (!directory) return [];
					const names: string[] = [];
					for await (const entry of directory.values())
						if (entry.kind === 'file' && isPlainName(entry.name))
							names.push(entry.name);
					return names.sort();
				},
				{ directory: true },
			),

		async readMany(paths) {
			const all: { path: string; segments: string[] }[] = [];
			for (const path of paths) {
				const checked = checkPath(path);
				if (checked.error) return checked;
				all.push({ path, segments: checked.data });
			}
			try {
				const read = new Map<string, string>();
				let next = 0;
				async function reader() {
					while (next < all.length) {
						const { path, segments } = all[next++] as (typeof all)[number];
						const file = await fileAt(segments);
						if (file) read.set(path, await file.text());
					}
				}
				await Promise.all(
					Array.from({ length: Math.min(READS_AT_ONCE, all.length) }, reader),
				);
				// In the order asked, as the desktop answers.
				return Ok(
					new Map(
						all.flatMap(({ path }) => {
							const text = read.get(path);
							return text === undefined ? [] : [[path, text] as const];
						}),
					),
				);
			} catch (cause) {
				return failed(
					`Could not read the files: ${extractErrorMessage(cause)}`,
				);
			}
		},

		write: (path, contents) =>
			io('write', path, async (segments) => {
				const parent = (await directoryAt(
					segments.slice(0, -1),
					true,
				)) as Directory;
				const handle = await parent.getFileHandle(segments.at(-1) as string, {
					create: true,
				});
				const stream = await handle.createWritable();
				try {
					await stream.write(toBytes(contents) as Uint8Array<ArrayBuffer>);
					await stream.close();
				} catch (cause) {
					await stream.abort().catch(() => {});
					throw cause;
				}
				return undefined;
			}),

		remove: (path) =>
			io('remove', path, async (segments) => {
				const parent = await directoryAt(segments.slice(0, -1), false);
				if (parent) {
					try {
						await parent.removeEntry(segments.at(-1) as string);
					} catch (cause) {
						if (!isMissing(cause)) throw cause;
					}
				}
				const url = urls.get(path);
				if (url) URL.revokeObjectURL(url);
				urls.delete(path);
				return undefined;
			}),

		url: (path) =>
			io('find', path, async (segments) => {
				const kept = urls.get(path);
				if (kept) return kept;
				const file = await fileAt(segments);
				if (!file) throw new Error('it is not there');
				const url = URL.createObjectURL(file);
				urls.set(path, url);
				return url;
			}),
	};
}
