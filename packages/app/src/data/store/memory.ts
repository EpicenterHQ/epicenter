/**
 * Bun-only data opening for tests. A fresh record belongs to the opened data;
 * a supplied record belongs to the caller and survives document disposal.
 *
 * This opens no App resources and claims no application library. Separate
 * records let tests model independent replicas of the same declaration.
 * Applications open through `openApp` from `@epicenter/app/open`.
 */
import { Database } from 'bun:sqlite';
import type { DataDefinition } from '@epicenter/app/definition';
import type { SqliteDatabase } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { type Data, openAccountStore } from './store.js';

/**
 * One durable record, held in memory, that outlives the stores opened over it.
 *
 * What a file gave a test and memory otherwise does not: a close and a reopen
 * of the SAME stored bytes. That is the shape of a release upgrade (ADR-0240),
 * of a boot that has to rehydrate what a previous run persisted, and of any
 * claim that something survives rather than merely exists.
 */
export type MemoryRecord = {
	/** Handed to `@epicenter/app/data` directly by tests that want the seam. */
	readonly sqlite: SqliteDatabase;
	close(): void;
};

export function createMemoryRecord(): MemoryRecord {
	const live = new Database(':memory:');
	return { sqlite: createBunSqliteAdapter(live), close: () => live.close() };
}

/**
 * Open a store over `record`, or over a fresh record of its own.
 *
 * Disposing the store closes the record only when this call minted it. A
 * record the caller passed in is the caller's to close, which is what makes
 * reopening it meaningful.
 */
export async function openMemory<const TDatabase extends DataDefinition>(
	definition: TDatabase,
	record?: MemoryRecord,
): Promise<Data<TDatabase>> {
	const durable = record ?? createMemoryRecord();
	return openAccountStore({
		definition,
		sqlite: durable.sqlite,
		dispose: record === undefined ? () => durable.close() : undefined,
	});
}
