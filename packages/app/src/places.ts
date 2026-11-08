/**
 * The places an action receives (ADR-0841): its folder, its cache, and its
 * secrets. Whatever runs the action supplies them: the `epicenter` CLI on a
 * computer, memory in a test.
 */
import type { Database } from 'bun:sqlite';

/**
 * An app's folder as an object. Paths are relative to the folder, with `/`
 * between parts; one that is absolute, climbs out with `..`, or reaches into
 * `.git` throws.
 */
export type Folder = {
	/** The text at `path`, or `undefined` when no file is there. */
	read(path: string): Promise<string | undefined>;
	readBytes(path: string): Promise<Uint8Array | undefined>;
	/** Writes `text` at `path`, making the directories it needs. */
	write(path: string, text: string): Promise<void>;
	writeBytes(path: string, bytes: Uint8Array): Promise<void>;
	/** Every file under `dir`, or the whole folder, relative to the folder and sorted. Never `.git` or `node_modules`. */
	list(dir?: string): Promise<string[]>;
	/** Deletes the file at `path`, if there is one. */
	remove(path: string): Promise<void>;
	/** The folder on disk; only on a computer. */
	readonly path?: string;
};

/**
 * What an app can rebuild: on this device only, never synced, never in
 * history. A cache is never migrated; after a change of shape it is cleared
 * and rebuilt.
 */
export type Cache = Folder & {
	/** Deletes everything in the cache. */
	clear(): Promise<void>;
	/** Bun's own database at `<name>.sqlite` in the cache; only on a computer. */
	sqlite?(name: string): Database;
};

/** Sign-ins, kept in this computer's Keychain under `epicenter.<app name>`. */
export type Secrets = {
	get(name: string): Promise<string | undefined>;
	set(name: string, value: string): Promise<void>;
	delete(name: string): Promise<void>;
};

export type Places = {
	folder: Folder;
	cache: Cache;
	/** Only on a computer. */
	secrets?: Secrets;
};

/**
 * `path` as a folder takes it: `./a//b.md` is `a/b.md`. Throws for an empty,
 * absolute, or climbing path, and for one inside `.git`.
 */
export function normalizePath(path: string): string {
	const parts = path.split('/').filter((part) => part !== '' && part !== '.');
	if (path.startsWith('/') || path.includes('\\'))
		throw new Error(`${JSON.stringify(path)} is not a relative path`);
	if (parts.length === 0) throw new Error('a path is needed');
	if (parts.includes('..'))
		throw new Error(`${JSON.stringify(path)} climbs out of the folder`);
	if (parts[0] === '.git')
		throw new Error(`${JSON.stringify(path)} is inside .git`);
	return parts.join('/');
}
