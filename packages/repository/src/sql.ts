/**
 * The one SQLite driver interface the device engine and the server core run
 * on. It is synchronous, like `bun:sqlite`, SQLite in a browser worker, and a
 * Durable Object's storage, so a batch applies inside one plain transaction.
 * Apps never see it: they read through the asynchronous repository API.
 */
export type SqlValue = string | number | bigint | null | Uint8Array;

export type SqlDriver = {
	exec(sql: string): void;
	all<TRow = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): TRow[];
	run(sql: string, params?: SqlValue[]): void;
	/** Run `fn` in one transaction; a throw rolls it back. Nested calls join it. */
	transaction<T>(fn: () => T): T;
	/**
	 * Register a deterministic one-argument SQL function, where the driver
	 * can (SQLite in a browser worker can; `bun:sqlite` cannot). The engine
	 * then computes stored columns in SQLite instead of in every write.
	 */
	registerFunction?(name: string, fn: (value: SqlValue) => SqlValue): void;
	close(): void;
};

/** The first row, or undefined. */
export function first<TRow>(driver: SqlDriver, sql: string, params?: SqlValue[]) {
	return driver.all<TRow>(sql, params)[0];
}
