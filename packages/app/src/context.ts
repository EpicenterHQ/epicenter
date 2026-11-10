/**
 * The context a run has (ADR-0841, ADR-0870): its folder. Whatever runs an
 * action opens the run, as `inRun(context, () => action(input))`: the
 * `epicenter` CLI on a computer, memory in a test. For the length of that run,
 * the app's collections and `folder` reach it, however deep the call, and an
 * action that calls another stays in the same run; outside any run they throw.
 * What an app can rebuild lives in files it gitignores, such as `ui/dist/`
 * (ADR-0854), and a `.local` file stays on this computer; neither is ever
 * committed.
 *
 * An action changes files and never commits: whatever runs it takes snapshots
 * of the folder into its history (ADR-0850). A change that depends on what it
 * read goes through a collection's `update`, or `folder.update` for any other
 * file. A read-only run may change only `.local` files, through `folder`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isLocalPath } from './local.ts';

/**
 * An app's folder as an object. Paths are relative to the folder, with `/`
 * between parts; one that is absolute, climbs out with `..`, or reaches into
 * `.git` throws. It is a convenience, not a sandbox: an action may use `path`
 * and `node:fs` directly.
 */
export type Folder = {
	/** The text at `path`, or `undefined` when no file is there. */
	read(path: string): Promise<string | undefined>;
	readBytes(path: string): Promise<Uint8Array | undefined>;
	/**
	 * Writes `text` at `path`, making the directories it needs. The last write
	 * wins: to change what you read, use `update`, so a change made meanwhile
	 * is not lost.
	 */
	write(path: string, text: string): Promise<void>;
	/**
	 * Changes the text at `path` to what `change` makes of it (`undefined` when
	 * no file is there), and returns the text written. When the file changes
	 * between the read and the write, `change` runs again on what is there
	 * now; after 10 tries it throws `{ name: 'Changed' }`. A `change` that
	 * throws writes nothing.
	 *
	 * ```ts
	 * await folder.update('2026.csv', (text = 'day,minutes\n') => `${text}${day},${minutes}\n`);
	 * ```
	 */
	update(
		path: string,
		change: (text: string | undefined) => string,
	): Promise<string>;
	writeBytes(path: string, bytes: Uint8Array): Promise<void>;
	/** Every file under `dir`, or the whole folder, relative to the folder and sorted. Never `.git` or `node_modules`. */
	list(dir?: string): Promise<string[]>;
	/** Deletes the file at `path`, if there is one. */
	delete(path: string): Promise<void>;
	/** The folder on disk; only on a computer. */
	readonly path?: string;
};

/** What whatever runs an action opens its run with. */
export type Context = {
	folder: Folder;
	/**
	 * The run is of a read-only action (`readOnlyHint: true`), named `action`:
	 * writes outside `.local` paths throw before doing anything. A raw `node:fs`
	 * write or an outside service is the action's own promise.
	 */
	readOnly?: { action: string };
};

const runs = new AsyncLocalStorage<Context>();

/**
 * Run `work` with `context` as its run's, so collections and `folder` reach it.
 * Only a runner opens a run; an action never does.
 */
export function inRun<T>(context: Context, work: () => T): T {
	return runs.run(context, work);
}

/** The context of the run this code is in; throws outside any run. */
function currentRun(): Context {
	const context = runs.getStore();
	if (!context)
		throw new Error(
			"An app's collections and folder are available only inside an action's run",
		);
	return context;
}

/** The context of the run this code is in, which `doing` changes; throws in a read-only run. */
function writableRun(path: string, doing: string): Context {
	const context = currentRun();
	if (context.readOnly && !isLocalPath(normalizePath(path)))
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
		writableRun(path, `write ${path}`).folder.write(path, text),
	writeBytes: async (path, bytes) =>
		writableRun(path, `write ${path}`).folder.writeBytes(path, bytes),
	update: async (path, change) =>
		writableRun(path, `write ${path}`).folder.update(path, change),
	list: (dir) => currentRun().folder.list(dir),
	delete: async (path) =>
		writableRun(path, `delete ${path}`).folder.delete(path),
	get path() {
		return currentRun().folder.path;
	},
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
