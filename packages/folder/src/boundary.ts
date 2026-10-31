/**
 * The directory storage contract (ADR-0576), which the Bun directory host
 * implements over `node:fs` (`directory-store.ts`) and the device store of
 * `/node` reads and changes files through. The desktop shell implements the
 * same contract natively (`storage.rs` in `tauri-plugin-epicenter-folder`);
 * a Tauri window's device store calls its commands (`device/tauri-store.ts`).
 *
 * `put` is the one change: one file's bytes, or its removal, landing only
 * while the path holds what the caller expects (`Expectation`), which may be
 * anything at all. It lands whole: a reader,
 * and a crash, see the old file or the new one, never part of either, and a
 * new file never appears empty first. The host checks the expectation right
 * before the change, with no lock between the two: a save another program
 * lands in that instant can be replaced, and Git history is the backstop
 * (ADR-0568).
 *
 * A name that only some disks can hold (`pathProblem`) is never created.
 * An existing one may be replaced or removed, and a write expecting `'any'`
 * there lands only while the file is still there, checked where it lands;
 * otherwise it is `InvalidPath`. A `HEAD` segment is never written.
 *
 * Where and under what names a new file is staged is here once, and the
 * desktop shell's own staging matches it.
 */
import type { Result } from 'wellcrafted/result';
import type { FileError } from './errors.js';

/**
 * What a change expects at its path when it lands: nothing there, a file, a
 * file whose bytes hash to `sha256`, or whatever is there. A host checks it
 * where the change lands, right before the change.
 */
export type Expectation =
	| 'absent'
	| 'present'
	| { readonly sha256: string }
	| 'any';

export type FileRead = {
	readonly bytes: Uint8Array;
	readonly sha256: string;
	readonly stamp: string;
};

export type PutOutcome =
	| { readonly kind: 'landed'; readonly stamp: string | null }
	| { readonly kind: 'stale' };

/**
 * One entry of a listing: anything that is not a directory, including files
 * outside portable scope, symbolic links, and special entries, none of them
 * followed. A read refuses what is not a regular file.
 */
export type ListedFile = {
	readonly path: string;
	readonly stamp: string;
};

/** A folder's files, as each host stores them. */
export type FolderStorage = {
	/** Every file below the folder, `.git` and `.epicenter` aside. */
	list(): Promise<Result<readonly ListedFile[], FileError>>;
	read(path: string): Promise<Result<FileRead, FileError>>;
	/**
	 * Publish `bytes` at `path`, or remove its file for `null`, only while
	 * the path holds what `expected` says. `'stale'` when it does not, and
	 * nothing changed; `'any'` is never stale. Removing nothing that may be
	 * absent has landed. Missing parent directories are made for a new file.
	 * The bytes land whole. The host checks the condition where the change
	 * lands, right before it. A reply that was lost is `Unconfirmed`.
	 */
	put(
		path: string,
		bytes: Uint8Array | null,
		expected: Expectation,
	): Promise<Result<PutOutcome, FileError>>;
};

/** The folder's private Git directory, which no portable path names and no listing shows. */
export const PRIVATE_DIRECTORY = '.git';

/**
 * Epicenter's own state at the top of a folder: the scratch directory saves
 * stage in, and unfinished files such as a recording in progress. No listing shows it and no watcher
 * reports it; `epicenter init`'s `.gitignore` keeps it out of history.
 */
export const STATE_DIRECTORY = '.epicenter';

/**
 * This process's id in the names it stages under, so two never pick one
 * name. Made at the first stage, not at import: an insecure origin has no
 * `crypto.randomUUID`, and opening there answers `NoFileSystem` rather than
 * failing to load.
 */
let engine: string | undefined;
let staged = 0;

/**
 * A new staged file's name: its creation time and a per-process counter in
 * base 36, around this process's engine id. Only ASCII letters, digits, and
 * `-`, which the desktop shell admits.
 */
export const scratchName = () => {
	engine ??= crypto.randomUUID().replaceAll('-', '');
	return `${Date.now().toString(36)}-${engine}-${(staged++).toString(36)}`;
};

/**
 * How old a staged file must be before a host removes it. A write moves its
 * staged file right after writing it, so one this old was left by a write
 * that stopped (a crash, a quit). Younger ones may belong to another process
 * writing the same folder: a script and a desktop window share no lock.
 */
const STALE_SCRATCH_MS = 60 * 60 * 1000;

const SCRATCH_NAME = /^([0-9a-z]+)-[0-9a-f]{32}-[0-9a-z]+$/;

/**
 * Whether the staged file `name` was made more than `STALE_SCRATCH_MS`
 * before `now`. A name no host made is never stale.
 */
export function isStaleScratch(name: string, now = Date.now()): boolean {
	const time = SCRATCH_NAME.exec(name)?.[1];
	if (time === undefined) return false;
	const created = Number.parseInt(time, 36);
	return Number.isSafeInteger(created) && now - created > STALE_SCRATCH_MS;
}
