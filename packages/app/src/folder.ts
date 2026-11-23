/**
 * A folder of files one app replaces whole. The library does not choose
 * where it is: `epicenter.ts` does, and hands the app its folder as it hands
 * over `data`.
 *
 * ```ts
 * // epicenter.ts
 * export default defineEpicenter({
 *   apps: { mail: mail(data, folderAt(import.meta.dir, '.epicenter/apps/mail')) },
 * });
 * ```
 *
 * `write` replaces a whole file at once, so a reader never sees half of it.
 * Names are relative to the folder, with `/` between parts, and come from the
 * app's code. An action that puts its input in a name checks the input in its
 * own schema. Every call is synchronous: between a `readText` and the `write`
 * after it, with no `await` between, nothing else in serve runs.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { filesIn, removeFile, replaceAt } from './disk.ts';

/** A folder on disk, and the calls that read and change its files. */
export type Folder = {
	/** The folder on disk, made if missing: for files that manage themselves, such as SQLite or an append-only log. */
	path(): string;
	/** The text of the file `name`, or `undefined` when there is none. */
	readText(name: string): string | undefined;
	/** The names of the files directly in `dir` (the folder itself when absent), sorted; none when `dir` is missing. */
	list(dir?: string): string[];
	/** Replace the file `name` at once, making its folder. The last write wins. */
	write(name: string, content: string | Uint8Array): void;
	/** Delete the file `name`, if there is one. */
	delete(name: string): void;
};

/**
 * The folder at `path`, whose parts are joined as `path.join` joins them.
 * Opening one touches no file, so importing
 * `epicenter.ts` changes nothing on disk; `path` and `write` make what they
 * need.
 */
export function folderAt(...path: string[]): Folder {
	const folder = join(...path);
	const at = (name: string) => join(folder, name);
	return {
		path() {
			mkdirSync(folder, { recursive: true });
			return folder;
		},
		readText(name) {
			try {
				return readFileSync(at(name), 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT')
					return undefined;
				throw error;
			}
		},
		list(dir) {
			const names = filesIn(dir === undefined ? folder : at(dir));
			return dir === undefined ? names : names.map((name) => `${dir}/${name}`);
		},
		write(name, content) {
			const bytes =
				typeof content === 'string'
					? new TextEncoder().encode(content)
					: content;
			replaceAt(at(name), bytes, at('.tmp'));
		},
		delete(name) {
			removeFile(at(name));
		},
	};
}
