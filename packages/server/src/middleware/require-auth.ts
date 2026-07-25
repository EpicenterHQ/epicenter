/**
 * Cookie-or-bearer authentication.
 *
 * Resolves `c.var.principal` from a Better Auth session cookie if one is
 * present; otherwise falls back to an OAuth bearer for the API audience.
 * Use this on routes served to both first-party browser callers (portal,
 * dashboard, hosted UIs) and external OAuth clients (CLI, Tauri,
 * extension).
 *
 * For routes that are external-clients only (`/api/ai/*`, `/api/.../rooms/*`),
 * prefer {@link requireBearerPrincipal}, which skips the cookie attempt.
 *
 * Cookie-vs-bearer is resolved deterministically here, cookie-first: a
 * request carrying both uses the cookie session and never consults the
 * bearer. The two credentials are read by disjoint paths and never merge,
 * so there is nothing to police at the edge: `getSession` reads only the
 * cookie (Better Auth's `bearer()` plugin is not enabled), while the bearer
 * fallback runs the {@link ResolveBearerPrincipal} the deployment closed this wrapper over
 * (in production {@link resolveRequestOAuthPrincipal}, which verifies the JWT against
 * JWKS; an instance closes over its env-token resolver instead).
 */

import { Principal } from '@epicenter/auth';
import { verifyJwsAccessToken } from 'better-auth/oauth2';
import { eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { createMiddleware } from 'hono/factory';
import { Ok, type Result } from 'wellcrafted/result';
import { OAuthError } from '../auth/oauth-errors.js';
import { createOAuthIssuerURL } from '../auth/oauth-metadata.js';
import { createOAuthUnauthorizedResourceResponse } from '../auth/oauth-resource.js';
import { parseBearer } from '../auth/parse-bearer.js';
import * as schema from '../db/schema/index.js';
import type { CloudEnv, Env, ResolveBearerPrincipal } from '../types.js';

/**
 * Resolve an OAuth bearer token to the calling principal.
 *
 * Both infrastructure reads (the signing keys and the user row) mean the token
 * could not be CHECKED, not that it is bad, so the HTTP status is decided by
 * WHICH step failed, not by inspecting error internals:
 *
 *   1. Verify the token against the signing keys. The keys come from
 *      `auth.api.getJwks()` (Better Auth's own JWKS projection, read from the
 *      same database in-process, with no HTTP hop to our own `/auth/jwks`,
 *      which loops back and fails inside a Cloudflare Worker). It is passed as
 *      `jwksFetch` rather than pre-fetched so Better Auth's module-level JWKS
 *      cache serves it: a token whose `kid` is already cached, or a non-JWT
 *      that never decodes far enough to need a key, costs no database read.
 *      `keysUnreadable` carries a key-read failure across that callback
 *      boundary. A verification failure with `keysUnreadable` set is a
 *      retryable 503 (the keys were unreachable, so the token was never
 *      checked); any other verification failure (bad signature, wrong
 *      audience/issuer, expired, malformed, unknown `kid`) is a 401.
 *
 *   2. Look up the subject. A database failure here is again infrastructure
 *      (a retryable 503); a successful query that finds no row is a genuine
 *      401 (the subject was deleted).
 *
 * A 503 matters because returning 401 on an infrastructure fault would make
 * the client discard and refresh a token that may be perfectly good, and pause
 * network auth over a transient server blip.
 *
 * The API origin (`c.var.authBaseURL`) is the resource audience; the same
 * origin plus `/auth` is the issuer. Cheap by design: only the calling
 * principal is needed once the token proves issuer, audience, signature,
 * expiration, and subject.
 */
export async function resolveRequestOAuthPrincipal(
	c: Context<CloudEnv>,
	accessToken: string,
): Promise<Result<Principal, OAuthError>> {
	const audience = c.var.authBaseURL;
	let keysUnreadable = false;
	let payload: Awaited<ReturnType<typeof verifyJwsAccessToken>>;
	try {
		payload = await verifyJwsAccessToken(accessToken, {
			jwksFetch: async () => {
				try {
					return await c.var.auth.api.getJwks();
				} catch {
					keysUnreadable = true;
					return undefined;
				}
			},
			verifyOptions: { audience, issuer: createOAuthIssuerURL(audience) },
		});
	} catch {
		return keysUnreadable
			? OAuthError.ServerError()
			: OAuthError.InvalidToken();
	}

	const userId = typeof payload?.sub === 'string' ? payload.sub : null;
	if (!userId) return OAuthError.InvalidToken();

	let user: Awaited<ReturnType<typeof c.var.db.query.user.findFirst>>;
	try {
		user = await c.var.db.query.user.findFirst({
			where: eq(schema.user.id, userId),
		});
	} catch {
		return OAuthError.ServerError();
	}
	if (!user) return OAuthError.InvalidToken();

	return Ok(Principal.assert(user));
}

/**
 * The tail every bearer guard shares: project a resolved principal onto the
 * request, or hand the OAuth error to a transport-specific renderer.
 *
 * The three guards ({@link requireCookieOrBearerPrincipal},
 * {@link requireBearerPrincipal}, and the rooms upgrade guard) differ only in
 * how they extract the bearer and how they render a rejection (an HTTP 401 vs a
 * WebSocket close). Once each has a `Result<Principal, OAuthError>`, the effect
 * is identical: on success stamp `c.var.principal` and continue; on failure
 * defer to `reject`.
 */
export async function setPrincipalOrReject<E extends Env>(
	c: Context<E>,
	next: Next,
	resolution: Result<Principal, OAuthError>,
	reject: (error: OAuthError) => Response | Promise<Response>,
): Promise<Response | undefined> {
	const { data: principal, error } = resolution;
	if (error) return reject(error);
	c.set('principal', principal);
	await next();
}

export function requireCookieOrBearerPrincipal(
	resolveBearerPrincipal: ResolveBearerPrincipal<CloudEnv>,
): MiddlewareHandler<CloudEnv> {
	return createMiddleware<CloudEnv>(async (c, next) => {
		const session = await c.var.auth.api.getSession({
			headers: c.req.raw.headers,
		});
		if (session) {
			c.set('principal', Principal.assert(session.user));
			return next();
		}
		const bearer = parseBearer(c.req.header('authorization') ?? null);
		const resolution = bearer
			? await resolveBearerPrincipal(c, bearer)
			: OAuthError.InvalidToken();
		return setPrincipalOrReject(c, next, resolution, (error) =>
			createOAuthUnauthorizedResourceResponse(c, error),
		);
	});
}

/**
 * Bearer-only authentication. Same as {@link requireCookieOrBearerPrincipal}
 * but skips the cookie path, so the route always reports 401 with a
 * standard OAuth `WWW-Authenticate` header instead of the cookie failure
 * path. Use on protected resource routes that should never see a browser
 * cookie (rooms, AI chat).
 *
 * A factory that closes over the deployment's {@link ResolveBearerPrincipal}:
 * the cloud passes {@link resolveRequestOAuthPrincipal}, an instance its
 * env-token resolver. There is no `c.var.resolveBearerPrincipal` seam; the
 * wrapper holds its resolver directly.
 */
export function requireBearerPrincipal<E extends Env = Env>(
	resolveBearerPrincipal: ResolveBearerPrincipal<E>,
): MiddlewareHandler<E> {
	return createMiddleware<E>(async (c, next) => {
		const bearer = parseBearer(c.req.header('authorization') ?? null);
		const resolution = bearer
			? await resolveBearerPrincipal(c, bearer)
			: OAuthError.InvalidToken();
		return setPrincipalOrReject(c, next, resolution, (error) =>
			createOAuthUnauthorizedResourceResponse(c, error),
		);
	});
}
