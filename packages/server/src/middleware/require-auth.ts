/**
 * The guards in front of every protected route (ADR-0549).
 *
 * - {@link requireAccessToken}: a resource. Only an OAuth access token for the
 *   route's audience with the route's scope reaches it.
 * - {@link requireSessionCookie}: an account-management route on the
 *   authorization server's own pages. Only the Better Auth session cookie,
 *   from the server's own origin, reaches it; no access token does.
 * - {@link requireBearerPrincipal}: the seam a dev-only entry closes over its
 *   own resolver for the runtime-parity smoke. No production route uses it.
 */
import { asPrincipalId } from '@epicenter/principal';
import type { Session, User } from 'better-auth';
import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { OAuthError } from '../auth/oauth-errors.js';
import type { OAuthScope } from '../auth/oauth-policy.js';
import { createOAuthUnauthorizedResourceResponse } from '../auth/oauth-resource.js';
import { parseBearer } from '../auth/parse-bearer.js';
import {
	authorizeAccountRequest,
	readAccessToken,
} from '../auth/resource-access.js';
import type { CloudEnv, Env, ResolveBearerPrincipal } from '../types.js';
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
			return createOAuthUnauthorizedResourceResponse(
				c,
				OAuthError.ServerError().error,
			);
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
 * its own requests here. An `Authorization` header is never read, so no
 * access token reaches account management (ADR-0549).
 *
 * Needs the cloud context (`c.var.auth`) installed before it.
 */
export function requireSessionCookie(): MiddlewareHandler<CloudEnv> {
	return createMiddleware<CloudEnv>(async (c, next) => {
		const origin = c.req.header('origin');
		if (origin !== undefined && origin !== new URL(c.var.authBaseURL).origin) {
			const refused = RequestGuardError.ForbiddenOrigin();
			return c.json(refused, refused.error.status);
		}
		const cookie = c.req.header('cookie');
		if (!cookie)
			return createOAuthUnauthorizedResourceResponse(
				c,
				OAuthError.InvalidToken().error,
			);
		let session: { session: Session; user: User } | null;
		try {
			session = await c.var.auth.api.getSession({
				headers: new Headers({ cookie }),
				query: { disableCookieCache: true },
			});
		} catch {
			return createOAuthUnauthorizedResourceResponse(
				c,
				OAuthError.ServerError().error,
			);
		}
		if (!session || session.session.expiresAt.getTime() <= Date.now())
			return createOAuthUnauthorizedResourceResponse(
				c,
				OAuthError.InvalidToken().error,
			);
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

/**
 * Admit a bearer the deployment's own resolver accepts. Only the dev entry
 * (`apps/api/server.dev.ts`) composes it, with its `dev:<principalId>`
 * resolver; production routes use {@link requireAccessToken}.
 */
export function requireBearerPrincipal<E extends Env = Env>(
	resolveBearerPrincipal: ResolveBearerPrincipal<E>,
): MiddlewareHandler<E> {
	return createMiddleware<E>(async (c, next) => {
		const bearer = parseBearer(c.req.header('authorization') ?? null);
		const { data: principal, error } = bearer
			? await resolveBearerPrincipal(c, bearer)
			: OAuthError.InvalidToken();
		if (error) return createOAuthUnauthorizedResourceResponse(c, error);
		c.set('principal', principal);
		await next();
	});
}
