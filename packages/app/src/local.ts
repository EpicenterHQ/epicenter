/**
 * Each app's folder under a home's `local/`: what this computer can lose
 * (caches it can rebuild, sign-ins you can redo) and private text that must
 * never reach Git. Only the app writes there, so nothing in it is a record
 * and no file is checked.
 *
 * ```ts
 * // epicenter.ts
 * const local = defineLocal(import.meta.dir);
 * export default defineEpicenter({ apps: { mail: mail(data, local('mail')) } });
 * ```
 *
 * The library promises three things:
 *
 * - `write` replaces a whole file at once, so a reader never sees half of it.
 * - `local/` is readable by its owner alone (0700), so nothing in it needs
 *   its own mode.
 * - `local/` has a `.gitignore`, so nothing in it reaches Git.
 *
 * Names are relative to the app's folder, with `/` between parts, and come
 * from the app's code. An action that puts its input in a name checks the
 * input in its own schema. Every call is synchronous: between a `readText`
 * and the `write` after it, with no `await` between, nothing else in serve
 * runs.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { filesIn, prepareLocal, removeFile, replaceFile } from './disk.ts';

/** An app's folder under `local/`, and the calls that read and change its files. */
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
 * The folders under `<home>/local/`: `local('mail')` is `local/mail/`.
 * `home` is the home's folder, `import.meta.dir` in its `epicenter.ts`; a
 * test passes a temporary one. Opening one touches no file, so importing
 * `epicenter.ts` changes nothing on disk; `path` and `write` make what they
 * need.
 */
export function defineLocal(home: string) {
	return (app: string): Folder => {
		const folder = join(home, 'local', app);
		const at = (name: string) => join(folder, name);
		return {
			path() {
				prepareLocal(home);
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
				return dir === undefined
					? names
					: names.map((name) => `${dir}/${name}`);
			},
			write(name, content) {
				const bytes =
					typeof content === 'string'
						? new TextEncoder().encode(content)
						: content;
				replaceFile(home, `local/${app}/${name}`, bytes);
			},
			delete(name) {
				removeFile(at(name));
			},
		};
	};
}
