/**
 * The guards in front of every protected route (ADR-0549).
 *
 * - {@link requireAccessToken}: a resource. Only an OAuth access token for the
 *   route's audience with the route's scope reaches it.
 * - {@link requireSessionCookie}: an account-management route on the
 *   authorization server's own pages. Only the Better Auth session cookie,
 *   from the server's own origin, reaches it; no access token does.
 */
import { asPrincipalId } from '@epicenter/principal';
import type { Session, User } from 'better-auth';
import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { OAuthScope } from '../auth/oauth-policy.js';
import {
	authorizeAccountRequest,
	readAccessToken,
} from '../auth/resource-access.js';
import type { CloudEnv } from '../types.js';
import { RequestGuardError } from './request-guard-errors.js';

/**
 * Admit a request that carries an access token for `audience` with `scope`,
 * and set `c.var.principal` to the account it acts for. A refusal answers
 * 401 or 403 with `WWW-Authenticate` naming the audience's
 * `resource_metadata` (RFC 9728); an unreadable database answers 503, so a
 * client keeps a token the server could not check.
 *
 * Needs the cloud context (`c.var.db`) installed before it.
 */
export function requireAccessToken({
	audience,
	scope,
}: {
	/** This resource's identifier, which the deployment names (ADR-0326). */
	audience: (c: Context<CloudEnv>) => string;
	scope: OAuthScope;
}): MiddlewareHandler<CloudEnv> {
	return createMiddleware<CloudEnv>(async (c, next) => {
		let decided: Awaited<ReturnType<typeof authorizeAccountRequest>>;
		try {
			decided = await authorizeAccountRequest(c.var.db, {
				token: readAccessToken(c.req.header('authorization')),
				audience: audience(c),
				scope,
			});
		} catch {
			const refused = RequestGuardError.TokenCheckUnavailable();
			return c.json(refused, refused.error.status);
		}
		const { data: access, error } = decided;
		if (error)
			return c.json(error.body, error.status, {
				'WWW-Authenticate': error.challenge,
			});
		c.set('principal', {
			id: asPrincipalId(access.accountId),
			email: access.email,
		});
		await next();
	});
}

/**
 * Admit a request from the authorization server's own pages: the Better Auth
 * session cookie, sent from this origin, for the account the page names in
 * `x-epicenter-principal` when it names one. A request whose `Origin` is another
 * origin is refused even when the browser attaches the cookie, since every
 * Epicenter app shares the site and so receives the `SameSite=Lax` cookie on
 * its own requests here; a request that changes state must name its origin.
 * An `Authorization` header is never read, so no access token reaches account
 * management (ADR-0549). A refusal is this guard's own JSON, with no bearer
 * challenge: no bearer is ever accepted here.
 *
 * Needs the cloud context (`c.var.auth`) installed before it.
 */
export function requireSessionCookie(): MiddlewareHandler<CloudEnv> {
	return createMiddleware<CloudEnv>(async (c, next) => {
		// A read without `Origin` is a same-origin navigation or fetch; a
		// request that changes state must name its origin.
		const ownOrigin = new URL(c.var.authBaseURL).origin;
		const readOnly = c.req.method === 'GET' || c.req.method === 'HEAD';
		const origin = c.req.header('origin') ?? (readOnly ? ownOrigin : null);
		if (origin !== ownOrigin) {
			const refused = RequestGuardError.ForbiddenOrigin();
			return c.json(refused, refused.error.status);
		}
		const cookie = c.req.header('cookie');
		if (!cookie) {
			const refused = RequestGuardError.SessionRequired();
			return c.json(refused, refused.error.status);
		}
		let session: { session: Session; user: User } | null;
		try {
			session = await c.var.auth.api.getSession({
				headers: new Headers({ cookie }),
				query: { disableCookieCache: true },
			});
		} catch {
			const refused = RequestGuardError.SessionUnavailable();
			return c.json(refused, refused.error.status);
		}
		if (!session || session.session.expiresAt.getTime() <= Date.now()) {
			const refused = RequestGuardError.SessionRequired();
			return c.json(refused, refused.error.status);
		}
		// A page opened for one account names it; a cookie that another tab
		// replaced with another account's must not answer for the first.
		const expected = c.req.header('x-epicenter-principal');
		if (expected !== undefined && expected !== session.user.id) {
			const refused = RequestGuardError.PrincipalMismatch();
			return c.json(refused, refused.error.status);
		}
		c.set('principal', {
			id: asPrincipalId(session.user.id),
			email: session.user.email,
		});
		await next();
	});
}
