/**
 * A folder on a temporary directory, as a test hands an app (ADR-0964).
 * Every directory made here sits under one root for this test process, and
 * the root is removed when the process exits.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { folderOnDisk } from './folder.ts';

let root: string | undefined;

function scratch() {
	if (root === undefined) {
		const made = realpathSync(mkdtempSync(join(tmpdir(), 'epicenter-app-')));
		root = made;
		process.on('exit', () => rmSync(made, { recursive: true, force: true }));
	}
	return root;
}

/**
 * Whether this computer's temporary disk takes two names that differ only by
 * case as one file, as macOS does and Linux does not.
 */
export const foldsCase = (() => {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-case-'));
	writeFileSync(join(dir, 'A'), '');
	const folds = existsSync(join(dir, 'a'));
	rmSync(dir, { recursive: true });
	return folds;
})();

let count = 0;

/**
 * A new directory with `files` written into it, and a folder on it. `read`
 * gives a file's text, or `undefined` when there is none; `files` lists the
 * files under a directory of it, folder-relative and sorted.
 */
export async function tempFolder(
	files: Readonly<Record<string, string | Uint8Array>> = {},
) {
	const dir = join(scratch(), String(++count));
	mkdirSync(dir);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), content);
	}
	return {
		dir,
		folder: folderOnDisk(dir),
		async read(path: string) {
			try {
				return await readFile(join(dir, path), 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT')
					return undefined;
				throw error;
			}
		},
		async files(under: string) {
			const start = join(dir, under);
			try {
				return (await readdir(start, { recursive: true, withFileTypes: true }))
					.filter((entry) => entry.isFile())
					.map((entry) => relative(dir, join(entry.parentPath, entry.name)))
					.sort();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
				throw error;
			}
		},
	};
}
