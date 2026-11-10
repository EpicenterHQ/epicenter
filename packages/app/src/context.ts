/**
 * The context an action's `run` receives (ADR-0841, ADR-0854): its folder and
 * its secrets. What an app can rebuild lives in files it gitignores inside the
 * folder, such as `.cache/`, written through `folder` like any file and never
 * committed. Whatever runs the action supplies the context: the `epicenter`
 * CLI on a computer, memory in a test.
 *
 * A write that returns is one commit, named for the call, made by whatever
 * runs it (ADR-0850); an action never commits.
 */

/**
 * An app's folder as an object. Paths are relative to the folder, with `/`
 * between parts; one that is absolute, climbs out with `..`, or reaches into
 * `.git` throws. It is a convenience, not a sandbox: writes are recorded
 * nowhere, and an action may use `path` and `node:fs` directly.
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
	delete(path: string): Promise<void>;
	/** The folder on disk; only on a computer. */
	readonly path?: string;
};

/** Sign-ins, kept in this computer's Keychain under `epicenter.<app name>`. */
export type Secrets = {
	get(name: string): Promise<string | undefined>;
	set(name: string, value: string): Promise<void>;
	delete(name: string): Promise<void>;
};

/** What `run` receives beside its input. */
export type Context = {
	folder: Folder;
	secrets: Secrets;
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
