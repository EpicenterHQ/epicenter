/**
 * The file system calls the directory storage is built on
 * (`directory-store.ts`), which Bun supplies over `node:fs`
 * (`directory-node.ts`). A desktop page has none: the shell answers each
 * storage method itself (`tauri-files.ts`). Paths are absolute and use `/`.
 */

import type { Expectation } from './boundary.js';

/** What one entry of a directory is, without following a link. */
export type EntryKind = 'file' | 'directory' | 'link' | 'other';

export type StampedBytes = {
	readonly bytes: Uint8Array;
	readonly stamp: string;
};

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
				readonly stamp: string;
				readonly mode?: number;
				readonly name?: string;
		  }
		| undefined
	>;
	readFile(path: string): Promise<Uint8Array>;
	/** Bytes and metadata from the same opened file. */
	readStamped(path: string): Promise<StampedBytes>;
	/**
	 * Write `bytes` to `path`. With `createNew`, reject when anything is
	 * already there. With `private`, a file this makes is readable only by
	 * this account (`0600` on Unix) before its first byte.
	 */
	writeFile(
		path: string,
		bytes: Uint8Array,
		options?: { readonly createNew?: boolean; readonly private?: boolean },
	): Promise<void>;
	/**
	 * Rename `from` to `to`, replacing a file at `to`, if `to` holds what
	 * `expected` says. Otherwise reject with `UnexpectedTarget` and change
	 * nothing; `from` stays. A regular file it replaces passes its permission
	 * bits to `from` first, so it stays private or executable.
	 */
	rename(from: string, to: string, expected: Expectation): Promise<string>;
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
	/**
	 * Make the directory at `path` and any missing ancestors. With `private`,
	 * make only `path`, whose parent is there, and leave it readable only by
	 * this account (`0700` on Unix), tightening one already there; reject
	 * when it is a link, is not a directory, or cannot be made private.
	 */
	mkdir(path: string, options?: { readonly private?: boolean }): Promise<void>;
};
