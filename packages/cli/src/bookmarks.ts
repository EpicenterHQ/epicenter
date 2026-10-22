/**
 * Folders this machine remembers in `<dataDir>/bookmarks.json`: a JSON array
 * of path strings, kept as written. The desktop reads the same array
 * (`bookmarks.rs` in `epicenter-folder-core`) and takes the same SQLite lock,
 * `.bookmarks.json.epicenter-save-lock`, across each read, change, and
 * atomic replace. A bookmark is a shortcut, never a permission or an app
 * default. An earlier build's `folders.json` is never read.
 */
import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { holdingFileLock } from '@epicenter/folder/bun';

const FILE = 'bookmarks.json';

/** Read without creating anything. An absent file holds no bookmarks. */
export async function readBookmarks(dataDir: string): Promise<string[]> {
	const path = join(dataDir, FILE);
	try {
		const kind = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
			if (cause.code === 'ENOENT') return undefined;
			throw cause;
		});
		if (kind === undefined) return [];
		if (!kind.isFile()) throw new Error('it is not a regular file');
		const value: unknown = JSON.parse(
			new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
				await readFile(path),
			),
		);
		if (
			!Array.isArray(value) ||
			!value.every((entry) => typeof entry === 'string')
		)
			throw new Error('it is not a JSON array of paths');
		return value;
	} catch (cause) {
		throw new Error(
			`${path} was left unchanged because ${cause instanceof Error ? cause.message : String(cause)}. Repair it to change bookmarks again.`,
		);
	}
}

/**
 * Read, change, and replace under the desktop's lock, so another writer's
 * entries survive. An unchanged list writes nothing. Answers whether it changed.
 */
export async function updateBookmarks(
	dataDir: string,
	change: (bookmarks: string[]) => string[],
): Promise<boolean> {
	const path = join(dataDir, FILE);
	await mkdir(dataDir, { recursive: true });
	return holdingFileLock(
		join(dataDir, `.${FILE}.epicenter-save-lock`),
		{
			waitMs: 10_000,
			held: `${path} was not updated: another writer held its save lock. Try again.`,
		},
		async () => {
			const before = await readBookmarks(dataDir);
			const after = change([...before]);
			if (JSON.stringify(after) === JSON.stringify(before)) return false;
			const staged = await mkdtemp(join(dataDir, `.${FILE}.`));
			try {
				const file = join(staged, 'staged');
				const output = await open(file, 'wx');
				try {
					await output.writeFile(`${JSON.stringify(after, null, 2)}\n`);
					await output.sync();
				} finally {
					await output.close();
				}
				await rename(file, path);
			} finally {
				await rm(staged, { recursive: true, force: true });
			}
			return true;
		},
	);
}
