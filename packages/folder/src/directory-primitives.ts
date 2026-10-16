/**
 * The file system calls a directory folder is built on (`directory-store.ts`),
 * which each host supplies: `node:fs` in Bun (`directory-node.ts`), and the
 * folder plugin's commands on the desktop (`directory-tauri.ts`). Paths are
 * absolute and use `/`.
 */

/**
 * What a change expects at its path when it lands: nothing there, a file, a
 * file whose bytes hash to `sha256`, or whatever is there. A host checks it
 * where the change lands and rejects with `UnexpectedTarget` when the path
 * holds something else.
 */
export type Expectation =
	| 'absent'
	| 'present'
	| { readonly sha256: string }
	| 'any';

/** What one entry of a directory is, without following a link. */
export type EntryKind = 'file' | 'directory' | 'link' | 'other';

/**
 * The file system calls a directory handle needs. Paths are absolute and use
 * `/`. Every call rejects on failure; `lstat` resolves `undefined` for a
 * missing path instead.
 */
export type DirectoryPrimitives = {
	/** Names in `path` and what each is, without following links. */
	readDir(
		path: string,
	): Promise<readonly { readonly name: string; readonly kind: EntryKind }[]>;
	/**
	 * What `path` is, without following a final link, or `undefined` when
	 * absent. `mode` is the Unix permission bits where the platform has them.
	 * `name` is the final segment as the file system stores it, which differs
	 * from the one asked for only on a case-insensitive file system; a
	 * platform that cannot say leaves it out, and the handle lists the parent
	 * instead.
	 */
	lstat(path: string): Promise<
		| {
				readonly kind: EntryKind;
				readonly size: number;
				readonly mode?: number;
				readonly name?: string;
		  }
		| undefined
	>;
	readFile(path: string): Promise<Uint8Array>;
	/**
	 * Write `bytes` to `path`. With `createNew`, reject when anything is
	 * already there.
	 */
	writeFile(
		path: string,
		bytes: Uint8Array,
		options?: { readonly createNew?: boolean },
	): Promise<void>;
	/**
	 * Rename `from` to `to`, replacing a file at `to`, if `to` holds what
	 * `expected` says. Otherwise reject with `UnexpectedTarget` and change
	 * nothing; `from` stays.
	 */
	rename(from: string, to: string, expected: Expectation): Promise<void>;
	/**
	 * Remove a file, an empty directory, or with `recursive` a whole tree. With
	 * `expected`, only if `path` holds what it says; otherwise reject with
	 * `UnexpectedTarget` and change nothing.
	 */
	remove(
		path: string,
		options?: {
			readonly recursive?: boolean;
			readonly expected?: Expectation;
		},
	): Promise<void>;
	/** Make the directory at `path` and any missing ancestors. */
	mkdir(path: string): Promise<void>;
};

/** Where a stream stages its bytes before they replace the path. */
export const SCRATCH_DIRECTORY = '.git/epicenter/scratch';

/**
 * How old a staged file must be before an open removes it. A stream renames
 * its staged file right after writing it, so one this old was left by a write
 * that stopped (a crash, a quit). Younger ones may belong to another process
 * writing the same directory: a script and a desktop window share no lock.
 */
const STALE_SCRATCH_MS = 60 * 60 * 1000;

/**
 * A staged file's name: its creation time and a per-call counter in base 36,
 * around the handle's random engine id, so two processes never pick the same
 * name. Only ASCII letters, digits, and `-`, which the desktop shell admits.
 */
const SCRATCH_NAME = /^([0-9a-z]+)-[0-9a-f]{32}-[0-9a-z]+$/;

/**
 * The name handles gave a staged file before each had an engine id: its
 * creation time (eight base-36 digits for any time since 1973), a counter,
 * and up to eight random characters, all in base 36. A folder may still hold
 * one a stopped write left.
 */
const EARLIER_SCRATCH_NAME = /^([0-9a-z]{8,})-[0-9a-z]+-[0-9a-z]{1,8}$/;

/**
 * Whether the staged file `name` was made more than `STALE_SCRATCH_MS`
 * before `now`. A name no handle made, now or earlier, is never stale.
 */
export function isStaleScratch(name: string, now = Date.now()): boolean {
	const time = (SCRATCH_NAME.exec(name) ??
		EARLIER_SCRATCH_NAME.exec(name))?.[1];
	if (time === undefined) return false;
	const created = Number.parseInt(time, 36);
	return Number.isSafeInteger(created) && now - created > STALE_SCRATCH_MS;
}
