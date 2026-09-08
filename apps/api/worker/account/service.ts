/**
 * The hosted account-deletion coordinator: retry-safe ordering with no
 * cross-system transaction. Every step is idempotent and they run in an
 * order that keeps a retry authenticated:
 *
 *   (There is no store step. See `routes.ts`.)
 *   1. blobs          removed-was-authority: the account Durable Object (
 *                     sockets) — never refused by allowance or the wall
 *   2. blobs          the `principals/<id>/blobs/` object prefix
 *   3. billing        the Autumn customer and its Stripe counterpart
 *   4. observations   hosted storage-observation rows (no FK, never cascade)
 *   5. auth user      the Better Auth user row; sessions, provider accounts,
 *                     and passkeys cascade from it
 *
 * The auth user goes LAST: it is the durable gate against any later
 * authenticated operation, and while it survives, a client can retry the
 * whole request after a partial failure. Deletion is complete only when the
 * route answers 204.
 */

import type { PrincipalId } from '@epicenter/principal';
import { extractErrorMessage } from 'wellcrafted/error';

const DELETION_STEPS = [
	'blobs',
	'billing',
	'observations',
	'auth-user',
] as const;

export type AccountDeletionStep = (typeof DELETION_STEPS)[number];

export type AccountDeletionDependencies = Record<
	AccountDeletionStep,
	() => Promise<void>
> & {
	reportError?(message: string): void;
};

export type AccountDeletionResult =
	| { outcome: 'deleted' }
	| { outcome: 'incomplete'; failedStep: AccountDeletionStep };

/**
 * Run the ordered deletion steps, stopping at the first failure. Every step
 * must be idempotent; the caller retries the whole sequence, so a step that
 * already succeeded runs again harmlessly.
 */
export async function runAccountDeletion(
	{ reportError = console.error, ...steps }: AccountDeletionDependencies,
	principalId: PrincipalId,
): Promise<AccountDeletionResult> {
	for (const step of DELETION_STEPS) {
		try {
			await steps[step]();
		} catch (cause) {
			reportError(
				`[account] deletion step '${step}' for ${principalId} failed: ${extractErrorMessage(cause)}`,
			);
			return { outcome: 'incomplete', failedStep: step };
		}
	}
	return { outcome: 'deleted' };
}
