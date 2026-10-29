/**
 * The SQLite driver for a browser worker: `@sqlite.org/sqlite-wasm` over the
 * `opfs-sahpool` VFS, which needs no cross-origin isolation. Each repository
 * gets its own pool (its own OPFS directory), because a pool is held by one
 * worker at a time and different repositories may be owned by different tabs.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import { wasmDriver } from '../hosts/browser/sqlite.js';
import type { SqlDriver } from '../sql.js';

export const BrowserStorageError = defineErrors({
	/** OPFS sync access handles are missing, or SQLite failed to load. */
	Unavailable: ({ cause }: { cause: unknown }) => ({
		message: 'This browser could not open the repository in its private storage',
		cause,
	}),
});
export type BrowserStorageError = InferErrors<typeof BrowserStorageError>;

/**
 * Open the repository's database in its own pool. The pool's sync access
 * handles belong to one worker at a time, and the worker of a tab that just
 * gave the repository up (or one that is frozen) may not have released them
 * yet, so this keeps trying until it lets go, calling `onWaiting` once, or
 * until `cancelled` says to stop. A failed attempt keeps the pool's files
 * (`preserveOnInitFailure`); without it the VFS deletes the whole pool when
 * it cannot acquire it. Closing the driver releases the handles at once.
 */
export async function openOpfsDatabase(
	name: string,
	{
		onWaiting = () => {},
		cancelled = () => false,
		maxDelayMs = 500,
	}: { onWaiting?: (reason: string) => void; cancelled?: () => boolean; maxDelayMs?: number } = {},
): Promise<Result<SqlDriver, BrowserStorageError>> {
	// Without sync access handles no wait helps.
	const handles =
		typeof FileSystemFileHandle === 'undefined'
			? undefined
			: (FileSystemFileHandle.prototype as { createSyncAccessHandle?: unknown }).createSyncAccessHandle;
	if (typeof navigator.storage?.getDirectory !== 'function' || typeof handles !== 'function')
		return BrowserStorageError.Unavailable({ cause: new Error('this browser has no OPFS sync access handles') });
	const sqlite3 = await tryAsync({
		try: () => sqlite3InitModule(),
		catch: (cause) => BrowserStorageError.Unavailable({ cause }),
	});
	if (sqlite3.error !== null) return sqlite3;
	let delay = 25;
	for (let attempt = 0; ; attempt++) {
		if (cancelled()) return BrowserStorageError.Unavailable({ cause: new Error('the open was cancelled') });
		const pool = await tryAsync({
			try: () =>
				sqlite3.data.installOpfsSAHPoolVfs({
					name: `epicenter-${name}`,
					directory: `.epicenter/${name}`,
					preserveOnInitFailure: true,
					// Retrying needs this too; the runtime takes it, the declarations omit it.
					...({ forceReinitIfPreviouslyFailed: true } as object),
				}),
			catch: (cause) => BrowserStorageError.Unavailable({ cause }),
		});
		if (pool.error === null) {
			const util = pool.data;
			const driver = wasmDriver(sqlite3.data, new util.OpfsSAHPoolDb('/repository.sqlite3'));
			return Ok({
				...driver,
				close() {
					driver.close();
					// Release the access handles now rather than when the worker is collected.
					util.pauseVfs();
				},
			});
		}
		if (attempt === 0) onWaiting(String((pool.error.cause as Error | undefined)?.message ?? pool.error.cause));
		await new Promise((resolve) => setTimeout(resolve, delay));
		delay = Math.min(delay * 2, maxDelayMs);
	}
}
