/**
 * A recovery journal on the filesystem, for proving restart rather than reopen.
 *
 * Bun tests can close a database and open it again, but that only shows the
 * record survives a handle. What the journal has to survive is a process that
 * is gone, so the bytes go to a real directory and every read comes from disk.
 * `fake-indexeddb` would keep them in the same heap and prove less.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JournalStorage } from './recovery-journal.js';

export function createFileJournalStorage(directory: string): JournalStorage {
	const path = (key: string) => join(directory, `${key}.bin`);
	return {
		async read(key) {
			try {
				return new Uint8Array(await readFile(path(key)));
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code === 'ENOENT')
					return undefined;
				throw cause;
			}
		},
		async write(key, bytes) {
			await mkdir(directory, { recursive: true });
			// Rename is what makes the header a commit marker rather than a window
			// a reader can catch half-written.
			const staging = `${path(key)}.writing`;
			await writeFile(staging, bytes);
			await rename(staging, path(key));
		},
		async clear() {
			await rm(directory, { recursive: true, force: true });
		},
	};
}
