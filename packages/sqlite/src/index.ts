/**
 * Values shared by SQLite bindings in browsers, Bun, and Durable Objects.
 * BLOB values bind as `Uint8Array`; Durable Object reads may surface them as
 * `ArrayBuffer`.
 */
export type SqliteValue = string | number | null | Uint8Array;

/** SQLite result rows may surface BLOBs as either view or backing buffer. */
export type SqliteRow = Record<string, SqliteValue | ArrayBuffer>;

/**
 * Opening existing durable storage requires a newer or explicit converter.
 *
 * Openers throw this before running schema DDL or persistent pragmas. The
 * storage owner decides whether to migrate, export, or ask the user to upgrade;
 * a generic SQLite adapter never repairs or recreates the file implicitly.
 */
export class StorageUpgradeRequiredError extends Error {
	override readonly name = 'StorageUpgradeRequired';

	constructor(
		readonly storage: string,
		readonly reason: string,
	) {
		super(`${storage} requires an explicit storage upgrade: ${reason}`);
	}
}

/**
 * The complete runtime-specific embedded SQLite boundary.
 *
 * Transactions are synchronous because every supported embedded SQLite engine
 * provides a synchronous transaction callback. Network and hashing work stays
 * outside this boundary.
 */
export type SqliteDatabase = {
	run(sql: string, parameters?: readonly SqliteValue[]): void;
	all<TRow extends SqliteRow>(
		sql: string,
		parameters?: readonly SqliteValue[],
	): TRow[];
	transaction<TResult>(run: () => TResult): TResult;
};
