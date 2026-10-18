/**
 * The file system calls the directory storage is built on
 * (`directory-store.ts`), which Bun supplies over `node:fs`
 * (`directory-node.ts`). A desktop page has none: the shell answers each
 * storage method itself (`tauri-files.ts`). Paths are absolute and use `/`.
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
	 * instead. `modified` and `stamp` are a listing's (`ListedFile` in
	 * `boundary.ts`): the modification time in milliseconds on this process's
	 * clock, and what else changes with the file, where the platform has them.
	 */
	lstat(path: string): Promise<
		| {
				readonly kind: EntryKind;
				readonly size: number;
				readonly mode?: number;
				readonly name?: string;
				readonly modified?: number;
				readonly stamp?: string;
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
