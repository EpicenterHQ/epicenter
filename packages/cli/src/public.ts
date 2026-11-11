/**
 * The public listener (ADR-0871, ADR-0881): what a connector needs from the
 * internet, reached through an HTTPS tunnel to 127.0.0.1 and the `connectors`
 * port. People reach an Epicenter over the tailnet, so nothing here is a page.
 *
 * ```txt
 * GET  /.well-known/oauth-protected-resource           RFC 9728 metadata
 * GET  /.well-known/oauth-authorization-server/.auth   RFC 8414 metadata
 * GET  /.auth/oauth2/authorize                         redirects to the approval page on the tailnet
 * POST /.auth/oauth2/token, /.auth/oauth2/revoke       a connector's tokens
 * GET  /.auth/jwks                                     the signing keys
 * POST /                                               MCP, with a connector's token
 * ```
 *
 * Anything else is 404. The boundary is the socket: this listener never
 * trusts a header to say where a request came from. Each request's URL is
 * rewritten to the public origin before Better Auth or the token check reads
 * it, since the tunnel delivers `http://127.0.0.1:<port>/...`.
 *
 * Every authorization shows the approval page and carries `offline_access`,
 * whatever the connector asked: the router forces `prompt=consent` and adds
 * the scope. A browser here has no session, so an authorization goes to the
 * approval page anyway; `prompt=consent` keeps it there if one of the
 * sessions `approve` makes ever reached this listener, since a stored consent
 * would otherwise let an authorization someone else started finish on its
 * own. Every code exchange starts a refresh family the generation trigger
 * checks (`authorization-server.ts`).
 */
import { createMcpProtectedRequestHandler } from '@better-auth/mcp';
import { createInsufficientScopeError } from 'better-auth/oauth2';
import {
	AUTH_BASE_PATH,
	type AuthorizationServer,
	SCOPES,
} from './authorization-server.ts';
import type { Site } from './http.ts';

/**
 * The Better Auth routes a connector uses, by method and path under `/.auth`;
 * every other route Better Auth or its plugins define answers 404. An
 * allowlist here, rather than Better Auth's `disabledPaths`, which matches
 * exact paths only and so cannot name a route with a parameter.
 */
const AUTH_ROUTES = new Set([
	'GET /oauth2/authorize',
	'POST /oauth2/token',
	// RFC 7009, with Better Auth's client checks: a connector's "disconnect".
	// It revokes the refresh token presented, not the grant; one presented
	// again after that ends every refresh token of the grant, as reuse does.
	'POST /oauth2/revoke',
	'GET /jwks',
]);

/** The metadata documents, answered by Better Auth outside `/.auth`. */
const METADATA_PATHS = new Set([
	'/.well-known/oauth-protected-resource',
	`/.well-known/oauth-authorization-server${AUTH_BASE_PATH}`,
]);

/**
 * The authorization server metadata Better Auth writes names introspection,
 * which this server does not offer to anyone; these fields go.
 */
const UNOFFERED_METADATA = [
	'introspection_endpoint',
	'introspection_endpoint_auth_methods_supported',
	'introspection_endpoint_auth_signing_alg_values_supported',
];

const notFound = () => new Response('Not found', { status: 404 });

/**
 * The authorization request as the router lets it reach Better Auth: the
 * approval page every time, and `offline_access` always among the scopes
 * asked for. A request with no scope asks for all of them; the approval
 * narrows.
 */
function forcedAuthorization(request: Request) {
	const url = new URL(request.url);
	url.searchParams.set('prompt', 'consent');
	const scopes = (url.searchParams.get('scope') ?? SCOPES.join(' '))
		.split(' ')
		.filter(Boolean);
	url.searchParams.set(
		'scope',
		[...new Set([...scopes, 'offline_access'])].join(' '),
	);
	return new Request(url, request);
}

/** Better Auth's authorization server metadata, less what this server does not offer. */
async function offeredMetadata(response: Response) {
	if (!response.ok) return response;
	const metadata = (await response.json()) as Record<string, unknown>;
	for (const field of UNOFFERED_METADATA) delete metadata[field];
	const headers = new Headers(response.headers);
	headers.delete('content-length');
	return Response.json(metadata, { status: response.status, headers });
}

/** The public listener's request handler, for `startPublicServer` and tests. */
export function publicHandler(
	authorization: AuthorizationServer,
	mcp: Site['mcp'],
) {
	const { origin, resource, issuer, handle } = authorization;
	/** RFC 6750's answer to a token whose grant was revoked or narrowed. */
	const revokedToken = () =>
		Response.json(
			{
				jsonrpc: '2.0',
				error: { code: -32000, message: 'This connection was revoked' },
				id: null,
			},
			{
				status: 401,
				headers: {
					'www-authenticate': `Bearer error="invalid_token", error_description="This connection was revoked", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
				},
			},
		);
	/** A connector's MCP request: its token decides what it may list and call. */
	const withToken = createMcpProtectedRequestHandler(
		{
			issuer,
			audience: resource,
			// The verifier calls a function source where it would fetch a URL
			// (better-auth/oauth2 verify), so the keys are read locally; the
			// option's type names only the URL.
			jwksUrl: authorization.jwks as unknown as string,
			jwtVerifyOptions: { requiredClaims: ['azp'], typ: 'at+jwt' },
		},
		async (request, claims) => {
			// The JWT proves who issued it; the database says whether that grant
			// still stands, so a revoke ends the token now, not when it expires.
			if (!authorization.isGrantLive(claims)) return revokedToken();
			const scopes = new Set(
				typeof claims.scope === 'string' ? claims.scope.split(' ') : [],
			);
			if (scopes.has('write')) return mcp(request);
			if (!scopes.has('read')) throw createInsufficientScopeError(['read']);
			// A read-only connection lists only reading tools, and any other
			// call is refused where the action is found (`run.ts`).
			return mcp(request, true);
		},
	);
	return async (incoming: Request): Promise<Response> => {
		const { pathname, search } = new URL(incoming.url);
		const request = new Request(`${origin}${pathname}${search}`, incoming);
		if (METADATA_PATHS.has(pathname))
			return pathname === '/.well-known/oauth-protected-resource'
				? handle(request)
				: offeredMetadata(await handle(request));
		if (pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
			const route = `${request.method} ${pathname.slice(AUTH_BASE_PATH.length)}`;
			if (!AUTH_ROUTES.has(route)) return notFound();
			return handle(
				route === 'GET /oauth2/authorize'
					? forcedAuthorization(request)
					: request,
			);
		}
		if (pathname === '/' && request.method === 'POST')
			return withToken(request);
		return notFound();
	};
}

/** Listen on 127.0.0.1 and `port`, where a tunnel from the public address forwards. */
export function startPublicServer(
	authorization: AuthorizationServer,
	port: number,
	mcp: Site['mcp'],
) {
	const fetch = publicHandler(authorization, mcp);
	return Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, fetch });
}
