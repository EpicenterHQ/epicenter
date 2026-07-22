/**
 * Hosted account deletion: `DELETE /api/account`.
 *
 * The route owns HTTP shape and wiring; `service.ts` owns the retry-safe
 * step order. A partial failure answers 503 with the failed step; deletion is
 * complete only when the route answers 204.
 *
 * Authentication is deliberately narrower than the other principal surfaces:
 * a FRESH host-only session cookie, read with the cookie cache disabled. A
 * bearer cannot trigger deletion (a leaked token must not be able to destroy
 * the account), a stale session is refused with the same `SESSION_NOT_FRESH`
 * remedy the dashboard already handles, and the cache bypass means this route
 * always observes the live session row.
 *
 * After the gated steps succeed, the Backup registry, authority, and blob
 * sweeps run once more:
 * while the auth user still existed, a signed-in device could re-register
 * workspace state or land a blob, so one post-fence pass sweeps that window.
 * Sweep failures are logged, not surfaced: the auth user is gone, no retry
 * can authenticate, and the residue is unreachable garbage, not user data.
 *
 * Known non-atomic residue, accepted and documented: a presigned blob PUT
 * issued up to five minutes earlier can land after the final sweep; other
 * cookie surfaces may honor the deleting browser's cached session for up to
 * five minutes after 204; an Autumn customer deleted out-of-band leaves any
 * Stripe counterpart to manual reconciliation (the 404 tolerance cannot see
 * Stripe).
 *
 * Lives in apps/api, not @epicenter/server: Better Auth, Postgres, and Autumn
 * are hosted-only deployment policy. The self-hosted instance has no per-user
 * account; its analog would be an operator-owned whole-instance reset, which
 * deliberately does not exist as an HTTP surface.
 */

import { Principal } from '@epicenter/auth';
import {
	blobPrincipalPrefix,
	type CloudEnv,
	createDataAuthorityAccountAuthorities,
	createDataBackupRegistryAccountAuthorities,
	createDurableObjectAccountAuthorities,
	type DeletableDataAuthorityNamespace,
	type DeletableDataBackupRegistryNamespace,
	deleteStorageObservations,
	resolveDeploymentBlobStore,
} from '@epicenter/server';
import {
	deleteHostedPrincipal,
	readHostedPrincipalEmail,
} from '@epicenter/server/cloud-db';
import type { Hono, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { describeRoute } from 'hono-openapi';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createBillingService } from '../billing/service.js';
import { type AccountDeletionStep, runAccountDeletion } from './service.js';

/**
 * Better Auth's `session.freshAge` default. The deployment's auth config does
 * not override freshAge (its type would carry the field if it did), so this
 * mirrors the same window `SESSION_NOT_FRESH` uses for login-method changes.
 */
const FRESH_AGE_SECONDS = 60 * 60 * 24;

/**
 * Error variants for the hosted deletion surface, owned beside their only
 * consumer: account deletion is hosted deployment policy (see the module
 * JSDoc), so this union is cloud-local, not a shared contract. Each factory
 * returns the wellcrafted envelope `{ data: null, error: { name, message,
 * ...fields } }` that `c.json` serializes directly. The dashboard branches on
 * HTTP status alone; `SessionNotFresh.code` mirrors the `SESSION_NOT_FRESH`
 * code Better Auth emits for the other fresh-session surfaces.
 */
const AccountDeletionError = defineErrors({
	Unauthorized: () => ({ message: 'Session required' }),
	SessionNotFresh: () => ({
		message: 'Sign in again to delete your account.',
		code: 'SESSION_NOT_FRESH',
	}),
	AccountDeletionIncomplete: ({
		failedStep,
	}: {
		failedStep: AccountDeletionStep;
	}) => ({
		message: `Account deletion did not complete (step: ${failedStep}). Retry the request.`,
		failedStep,
	}),
});

/**
 * Cookie-only, cache-bypassing, freshness-gated authentication for the one
 * destructive account surface. Mirrors Better Auth's own `freshAge` check
 * (`base-config.ts`) so the dashboard's existing `SESSION_NOT_FRESH` re-sign-in
 * remedy applies unchanged.
 */
const requireFreshCookieSession: MiddlewareHandler<CloudEnv> =
	createMiddleware<CloudEnv>(async (c, next) => {
		const session = await c.var.auth.api.getSession({
			headers: c.req.raw.headers,
			query: { disableCookieCache: true },
		});
		if (!session) {
			return c.json(AccountDeletionError.Unauthorized(), 401);
		}
		const createdAt = new Date(session.session.createdAt).getTime();
		if (Date.now() - createdAt >= FRESH_AGE_SECONDS * 1000) {
			return c.json(AccountDeletionError.SessionNotFresh(), 403);
		}
		c.set('principal', Principal.assert(session.user));
		return next();
	});

/** Mount the hosted account-deletion route with its bundled destructive auth. */
export function mountAccountDeletionApi(app: Hono<CloudEnv>): void {
	app.delete(
		'/api/account',
		describeRoute({
			description:
				'Delete the authenticated account everywhere: Backups, authority storage, blobs, billing customer, storage observations, and the auth user. Requires a fresh session cookie. Retry until 204.',
			tags: ['account'],
		}),
		requireFreshCookieSession,
		async (c) => {
			const principalId = c.var.principal.id;
			const sweepAuthorities = async () => {
				// Fence Backup publication first and drain every admitted capture before
				// deleting either live authority owner.
				await createDataBackupRegistryAccountAuthorities(
					(c.env as Cloudflare.Env)
						.DATA_BACKUP_REGISTRY as unknown as DeletableDataBackupRegistryNamespace,
				)
					.authority(principalId)
					.deleteAccount();
				await Promise.all([
					createDurableObjectAccountAuthorities(
						(c.env as Cloudflare.Env).EPICENTER_SYNC,
					)
						.authority(principalId)
						.deleteAccount(),
					createDataAuthorityAccountAuthorities(
						(c.env as Cloudflare.Env)
							.DATA_AUTHORITY as unknown as DeletableDataAuthorityNamespace,
					)
						.authority(principalId)
						.deleteAccount(),
				]);
			};
			const sweepBlobs = async () => {
				const store = resolveDeploymentBlobStore(c.env);
				if (!store) {
					// The hosted deployment always configures object storage, so an
					// unresolved store is a misconfiguration. Failing closed keeps a
					// 204 honest about "uploaded files are deleted".
					throw new Error('Hosted blob storage is not configured');
				}
				await store.deletePrefix(blobPrincipalPrefix(principalId));
			};
			const result = await runAccountDeletion(
				{
					authority: async () => {
						await sweepAuthorities();
					},
					blobs: sweepBlobs,
					async billing() {
						const principalEmail = await readHostedPrincipalEmail(
							c.var.db,
							principalId,
						);
						// The auth user deletes last and this route bypasses the cookie
						// cache, so the row must still exist here; its absence means
						// out-of-band interference and the step fails loudly.
						if (principalEmail === null) {
							throw new Error('Account user row disappeared mid-deletion');
						}
						const { error } = await createBillingService(
							c.env as Cloudflare.Env,
							{ principalId, principalEmail },
						).deleteCustomer();
						if (error) throw new Error(extractErrorMessage(error));
					},
					observations: () => deleteStorageObservations(c.var.db, principalId),
					'auth-user': () => deleteHostedPrincipal(c.var.db, principalId),
				},
				principalId,
			);
			if (result.outcome === 'incomplete') {
				return c.json(
					AccountDeletionError.AccountDeletionIncomplete({
						failedStep: result.failedStep,
					}),
					503,
				);
			}
			// Post-fence sweeps: close the recreation window that was open while
			// the auth user still authenticated pushes and uploads. Best-effort by
			// design; see the module JSDoc.
			for (const [name, sweep] of [
				['authority-sweep', sweepAuthorities],
				['blobs-sweep', sweepBlobs],
			] as const) {
				try {
					await sweep();
				} catch (cause) {
					console.error(
						`[account] post-fence ${name} for ${principalId} failed: ${extractErrorMessage(cause)}`,
					);
				}
			}
			return c.body(null, 204);
		},
	);
}
