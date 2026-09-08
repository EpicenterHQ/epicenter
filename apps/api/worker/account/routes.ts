/** Hosted account deletion requires a live, fresh, principal-bound session bearer. */

import { asPrincipalId } from '@epicenter/principal';
import type { CloudEnv } from '@epicenter/server';
import type { Session, User } from 'better-auth';
import { APIError } from 'better-auth/api';
import type { Hono, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { describeRoute } from 'hono-openapi';
import { defineErrors } from 'wellcrafted/error';

/**
 * Error variants for the hosted deletion surface, owned beside their only
 * consumer: account deletion is hosted deployment policy (see the module
 * JSDoc), so this union is cloud-local, not a shared contract. Each factory
 * returns the wellcrafted envelope `{ data: null, error: { name, message,
 * ...fields } }` that `c.json` serializes directly. `SessionNotFresh.code`
 * mirrors the `SESSION_NOT_FRESH` code Better Auth emits for the other
 * fresh-session surfaces.
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
	AccountDeletionUnavailable: () => ({
		code: 'ACCOUNT_DELETION_UNAVAILABLE',
		message:
			'Account deletion is unavailable because complete removal of hosted data cannot yet be guaranteed. No deletion has started.',
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

/**
 * Refuse deletion before any destructive work until historical storage ownership
 * and write retirement are established. See README.md for the missing evidence.
 */
export function mountAccountDeletionApi(app: Hono<CloudEnv>): void {
	app.delete(
		'/api/account',
		describeRoute({
			description:
				'Account deletion is unavailable. A valid fresh account session receives 503 with ACCOUNT_DELETION_UNAVAILABLE; no deletion is accepted or started.',
			tags: ['account'],
		}),
		requireFreshAccountSession,
		(c) => c.json(AccountDeletionError.AccountDeletionUnavailable(), 503),
	);
}
