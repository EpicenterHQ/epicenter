import type { PrincipalId } from '@epicenter/principal';
import { eq } from 'drizzle-orm';
import type { Db } from './create-db.js';
import { user } from './schema/auth.js';

/** Read the hosted account email needed by account-scoped external policy. */
export async function readHostedPrincipalEmail(
	db: Db,
	principalId: PrincipalId,
): Promise<string | null> {
	const [principal] = await db
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, principalId))
		.limit(1);
	return principal?.email ?? null;
}

/**
 * Delete the hosted auth user during account deletion. Sessions, provider
 * accounts and passkeys cascade from the user row
 * (schema/auth.ts), so removing it is the durable gate against any later
 * authenticated operation. Idempotent for coordinator retries; run it LAST so
 * a retry after an earlier partial failure can still authenticate.
 */
export async function deleteHostedPrincipal(
	db: Db,
	principalId: PrincipalId,
): Promise<void> {
	await db.delete(user).where(eq(user.id, principalId));
}
