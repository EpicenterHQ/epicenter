/**
 * Browser durable storage for the recovery journal.
 *
 * Its own IndexedDB database, not another object store inside the replica's.
 * Retirement clears the cache's stores and reloads the document, and the
 * pending intent has to still be there afterwards, so sharing a database with
 * the thing being invalidated would defeat the record's only purpose. The
 * address carries the full library identity (`recoveryJournalAddress`), which
 * is what keeps two libraries open in two tabs from reading each other's slot.
 */
import type { DBSchema, IDBPDatabase } from 'idb';
import { openDB } from 'idb';
import type { JournalStorage } from '../recovery-journal.js';

type JournalSchema = DBSchema & {
	intent: { key: string; value: Uint8Array };
};

/** Open the journal at one address. The caller closes it with the page. */
export async function openIdbJournalStorage(address: string): Promise<
	JournalStorage & {
		close(): void;
	}
> {
	const database: IDBPDatabase<JournalSchema> = await openDB<JournalSchema>(
		address,
		1,
		{
			upgrade(upgraded) {
				upgraded.createObjectStore('intent');
			},
		},
	);
	return {
		async read(key) {
			const held = await database.get('intent', key);
			// Structured clone returns the stored view; copy so a caller that keeps
			// it cannot be surprised by a detached or reused buffer later.
			return held === undefined ? undefined : new Uint8Array(held);
		},
		async write(key, bytes) {
			await database.put('intent', new Uint8Array(bytes), key);
		},
		async clear() {
			await database.clear('intent');
		},
		close() {
			database.close();
		},
	};
}
