/**
 * The context a run has (ADR-0841, ADR-0854): its folder. Whatever runs an
 * action opens the run, as `inRun(context, () => action(input))`: the
 * `epicenter` CLI on a computer, memory in a test. For the length of that
 * run, the app's data handles and `folder` reach it, however deep the call,
 * and an action that calls another stays in the same run; outside any run
 * they throw. What an app can rebuild lives in files it gitignores inside the
 * folder, such as `code/ui/dist/`, and is never committed. A run writes only under
 * `data/` and `local/`; reads may reach any app file. What is in `local/`
 * stays on this computer.
 *
 * An action changes files and never commits: Git stores the home, and the
 * home's own commits record pending code and records together. A change that depends on what it
 * read goes through a data handle's `update`, or `folder.update` for any other
 * file. Nothing here knows whether an action says it is read-only: that is a
 * hint the action gives MCP clients, and no write is refused for it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Ok, type Result, unwrap } from 'wellcrafted/result';

/** Decide synchronously from the current text. Omit text to leave the path as it was. */
type EditFile = <T, E extends object>(
	path: string,
	decide: (
		before: string | undefined,
	) => Result<{ value: T; text?: string }, E>,
) => Promise<Result<T, E>>;

/** Adapt a folder provider's atomic edit to the raw text update contract. */
export function textUpdate(edit: EditFile): Folder['update'] {
	return async (path, change) =>
		unwrap(
			await edit<string, never>(path, (before) => {
				const text = change(before);
				return Ok({ value: text, text });
			}),
		);
}

/**
 * An app's folder as an object. Paths are relative to the folder, with `/`
 * between parts; one that is absolute, climbs out with `..`, or reaches into
 * `.git` throws. It is a convenience, not a sandbox: an action may use `path`
 * and `node:fs` directly. A run writes only under `data/` and `local/`, and
 * never into `.git`; reads may reach other app files.
 */
export type Folder = {
	edit: EditFile;
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
	 * no file is there), and returns the text written; nothing is written when
	 * that is what is there. `change` runs once, and no other update runs
	 * between its read and its write. A `change` that throws writes nothing.
	 *
	 * ```ts
	 * await folder.update('data/2026.csv', (text = 'day,minutes\n') => `${text}${day},${minutes}\n`);
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
};

const runs = new AsyncLocalStorage<Context>();

/**
 * Run `work` with `context` as its run's, so data handles and `folder` reach
 * it. Only a runner opens a run; an action never does.
 */
export function inRun<T>(context: Context, work: () => T): T {
	return runs.run(context, work);
}

/** The context of the run this code is in; throws outside any run. */
function currentRun(): Context {
	const context = runs.getStore();
	if (!context)
		throw new Error(
			"An app's data and folder are read only inside an action's run",
		);
	return context;
}

/**
 * The folder of the run this code is in, to write or delete `path` in. Every
 * write stays under `data/`, which is committed, or `local/`, which stays on
 * this computer.
 */
function writableFolder(path: string): Folder {
	const context = currentRun();
	const normal = normalizePath(path);
	if (!normal.startsWith('data/') && !isUnderLocal(normal))
		throw new Error(
			`${path} is outside data/ and local/, and an action writes only there`,
		);
	return context.folder;
}

/** The folder of the run this code is in. */
export const folder: Folder = {
	edit: async (path, decide) => writableFolder(path).edit(path, decide),
	read: (path) => currentRun().folder.read(path),
	readBytes: (path) => currentRun().folder.readBytes(path),
	write: async (path, text) => writableFolder(path).write(path, text),
	writeBytes: async (path, bytes) =>
		writableFolder(path).writeBytes(path, bytes),
	update: async (path, change) => writableFolder(path).update(path, change),
	list: (dir) => currentRun().folder.list(dir),
	delete: async (path) => writableFolder(path).delete(path),
	get path() {
		return currentRun().folder.path;
	},
};

/**
 * Whether `path`, as `normalizePath` returns it, is in the app's `local/`.
 * What is there stays on this computer: the home's ignore file keeps it out of
 * every commit, and a new file there is readable by its owner alone.
 */
export function isUnderLocal(path: string): boolean {
	return path.startsWith('local/');
}

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
