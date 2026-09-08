/** Hosted account deletion requires a live, fresh, principal-bound session bearer. */

import { asPrincipalId } from '@epicenter/principal';
import {
	blobPrincipalPrefix,
	type CloudEnv,
	deleteStorageObservations,
	resolveDeploymentBlobStore,
} from '@epicenter/server';
import {
	deleteHostedPrincipal,
	readHostedPrincipalEmail,
} from '@epicenter/server/cloud-db';
import type { Session, User } from 'better-auth';
import { APIError } from 'better-auth/api';
import type { Hono, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { describeRoute } from 'hono-openapi';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createBillingService } from '../billing/service.js';
import { type AccountDeletionStep, runAccountDeletion } from './service.js';

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
	SessionUnavailable: () => ({ message: 'Session database unavailable' }),
	PrincipalMismatch: () => ({
		code: 'PRINCIPAL_MISMATCH',
		message: 'Account changed',
	}),
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
 * A captured bearer, checked against the live session and expected principal.
 * Deletion uses the same freshness window as login-method changes.
 */
const requireFreshAccountSession: MiddlewareHandler<CloudEnv> =
	createMiddleware<CloudEnv>(async (c, next) => {
		const authorization = c.req.header('authorization');
		if (!authorization) return c.json(AccountDeletionError.Unauthorized(), 401);
		let session: { session: Session; user: User } | null;
		try {
			session = await c.var.auth.api.getSession({
				headers: new Headers({ authorization }),
				query: { disableCookieCache: true, disableRefresh: true },
			});
		} catch (cause) {
			if (cause instanceof APIError && cause.statusCode === 401)
				return c.json(AccountDeletionError.Unauthorized(), 401);
			return c.json(AccountDeletionError.SessionUnavailable(), 503);
		}
		if (!session || session.session.expiresAt.getTime() <= Date.now())
			return c.json(AccountDeletionError.Unauthorized(), 401);
		if (c.req.header('x-epicenter-principal') !== session.user.id)
			return c.json(AccountDeletionError.PrincipalMismatch(), 403);
		const createdAt = new Date(session.session.createdAt).getTime();
		if (Date.now() - createdAt >= c.var.auth.options.session.freshAge * 1000) {
			return c.json(AccountDeletionError.SessionNotFresh(), 403);
		}
		c.set('principal', {
			id: asPrincipalId(session.user.id),
			email: session.user.email,
		});
		return next();
	});

/** Mount the hosted account-deletion route with its bundled destructive auth. */
export function mountAccountDeletionApi(app: Hono<CloudEnv>): void {
	app.delete(
		'/api/account',
		describeRoute({
			description:
				'Delete the authenticated account everywhere: authority storage, blobs, billing customer, storage observations, and the auth user. Requires a fresh session bearer bound to the invoking principal. Retry until 204.',
			tags: ['account'],
		}),
		requireFreshAccountSession,
		async (c) => {
			const principalId = c.var.principal.id;
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
			for (const [name, sweep] of [['blobs-sweep', sweepBlobs]] as const) {
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
