/**
 * The context a run has (ADR-0841, ADR-0854): its folder and its secrets.
 * Whatever runs an action opens the run, as
 * `inRun(context, () => action(input))`: the `epicenter` CLI on a computer,
 * memory in a test. For the length of that run, the app's collections,
 * `folder`, and `secrets` reach it, however deep the call, and an action that
 * calls another stays in the same run; outside any run they throw. What an
 * app can rebuild lives in files it gitignores inside the folder, such as
 * `.cache/`, and is never committed.
 *
 * A write, whether its action returns or throws, is one commit named for the
 * call, made by whatever runs it (ADR-0850); an action never commits. A run
 * of a read-only action refuses every write through `folder` and `secrets`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

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

/** An app's sign-ins: never returned to a caller, and never in its files. */
export type Secrets = {
	get(name: string): Promise<string | undefined>;
	set(name: string, value: string): Promise<void>;
	delete(name: string): Promise<void>;
};

/** What whatever runs an action opens its run with. */
export type Context = {
	folder: Folder;
	secrets: Secrets;
	/**
	 * The run is of a read-only action (`readOnlyHint: true`), named `action`:
	 * `folder.write`, `writeBytes`, `delete`, `secrets.set`, and
	 * `secrets.delete` throw in it before doing anything. A raw `node:fs` write
	 * or an outside service is the action's own promise.
	 */
	readOnly?: { action: string };
};

const runs = new AsyncLocalStorage<Context>();

/**
 * Run `work` with `context` as its run's, so collections, `folder`, and
 * `secrets` reach it. Only a runner opens a run; an action never does.
 */
export function inRun<T>(context: Context, work: () => T): T {
	return runs.run(context, work);
}

/** The context of the run this code is in; throws outside any run. */
function currentRun(): Context {
	const context = runs.getStore();
	if (!context)
		throw new Error(
			"An app's collections, folder, and secrets are read only inside an action's run",
		);
	return context;
}

/** The context of the run this code is in, which `doing` changes; throws in a read-only run. */
function writableRun(doing: string): Context {
	const context = currentRun();
	if (context.readOnly)
		throw new Error(
			`The action "${context.readOnly.action}" is read-only, so it cannot ${doing}`,
		);
	return context;
}

/** The folder of the run this code is in. */
export const folder: Folder = {
	read: (path) => currentRun().folder.read(path),
	readBytes: (path) => currentRun().folder.readBytes(path),
	write: async (path, text) =>
		writableRun(`write ${path}`).folder.write(path, text),
	writeBytes: async (path, bytes) =>
		writableRun(`write ${path}`).folder.writeBytes(path, bytes),
	list: (dir) => currentRun().folder.list(dir),
	delete: async (path) => writableRun(`delete ${path}`).folder.delete(path),
	get path() {
		return currentRun().folder.path;
	},
};

/** The secrets of the run this code is in: the app's own sign-ins. */
export const secrets: Secrets = {
	get: (name) => currentRun().secrets.get(name),
	set: async (name, value) =>
		writableRun(`set the secret ${name}`).secrets.set(name, value),
	delete: async (name) =>
		writableRun(`delete the secret ${name}`).secrets.delete(name),
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
