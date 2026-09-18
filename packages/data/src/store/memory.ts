/**
 * A store whose durable record lives only as long as the process. Test support.
 *
 * Not a runtime an application opens. An application opens the browser store
 * (`@epicenter/data/browser`), which is the one opener a person's data ever
 * lands in: the desktop SPA runs in a WebView over a client-owned store
 * (ADR-0227), and the host owns no application data (ADR-0226). The file
 * opener that used to sit beside this one was deleted with the runtime it
 * served; a Bun or CLI process opening a person's store is a decision, not a
 * default, and would earn its own named opener.
 *
 * It takes the definition for the same reason every opener does, so one entry
 * point has one shape (ADR-0229). It claims no address, and that is not an
 * oversight: two memory stores that mint their own records are two independent
 * documents by construction, which is the two-devices case rather than the
 * two-handles-on-one-record case the claim exists to refuse.
 */
import { Database } from 'bun:sqlite';
import type { DataDefinition } from '@epicenter/data/definition';
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
	/** Handed to `@epicenter/data/direct` directly by tests that want the seam. */
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
