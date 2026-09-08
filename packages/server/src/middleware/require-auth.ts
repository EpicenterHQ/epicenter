/**
 * Hosted resources accept an explicit signed session bearer. The instance
 * supplies its static-token resolver to the same bearer guard.
 */
import type { Principal } from '@epicenter/auth';
import { asPrincipalId } from '@epicenter/principal';
import { APIError } from 'better-auth/api';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { createMiddleware } from 'hono/factory';
import { Ok, type Result } from 'wellcrafted/result';
import { OAuthError } from '../auth/oauth-errors.js';
import { createOAuthUnauthorizedResourceResponse } from '../auth/oauth-resource.js';
import { parseBearer } from '../auth/parse-bearer.js';
import type { CloudEnv, Env, ResolveBearerPrincipal } from '../types.js';

/**
 * Resolve and renew through Better Auth's live session route. Only the explicit
 * bearer crosses this boundary; unrelated cookies cannot select another user.
 * A missing/revoked session is 401; an unreadable database is retryable 503.
 */
export async function resolveRequestSessionPrincipal(
	c: Context<CloudEnv>,
	sessionToken: string,
): Promise<Result<Principal, OAuthError>> {
	try {
		const session = await c.var.auth.api.getSession({
			headers: new Headers({ authorization: `Bearer ${sessionToken}` }),
			query: { disableCookieCache: true },
		});
		if (!session || session.session.expiresAt.getTime() <= Date.now())
			return OAuthError.InvalidToken();
		return Ok({ id: asPrincipalId(session.user.id), email: session.user.email });
	} catch (cause) {
		return cause instanceof APIError && cause.statusCode === 401
			? OAuthError.InvalidToken()
			: OAuthError.ServerError();
	}
}

/** Set the principal or return the shared HTTP rejection, including upgrades. */
export async function setPrincipalOrReject<E extends Env>(
	c: Context<E>,
	next: Next,
	resolution: Result<Principal, OAuthError>,
): Promise<Response | undefined> {
	const { data: principal, error } = resolution;
	if (error) return createOAuthUnauthorizedResourceResponse(c, error);
	c.set('principal', principal);
	await next();
}

export function requireBearerPrincipal<E extends Env = Env>(
	resolveBearerPrincipal: ResolveBearerPrincipal<E>,
): MiddlewareHandler<E> {
	return createMiddleware<E>(async (c, next) => {
		const bearer = parseBearer(c.req.header('authorization') ?? null);
		const resolution = bearer
			? await resolveBearerPrincipal(c, bearer)
			: OAuthError.InvalidToken();
		return setPrincipalOrReject(c, next, resolution);
	});
}
