import { eq } from 'drizzle-orm';
import type { Db } from './create-db.js';
import { storageObservation } from './schema/storage.js';

/**
 * Remove every observation for one account during account deletion. These
 * rows carry a plain principalId with no foreign key to the auth user, so
 * they never cascade; idempotent for coordinator retries.
 */
export async function deleteStorageObservations(
	db: Db,
	principalId: string,
): Promise<void> {
	await db
		.delete(storageObservation)
		.where(eq(storageObservation.principalId, principalId));
}
