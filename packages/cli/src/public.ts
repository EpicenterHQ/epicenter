/**
 * The public listener (ADR-0871): the site of `http.ts` for the internet,
 * reached through an HTTPS tunnel to 127.0.0.1 and `publicPort`. Every
 * request carries a person's session or a connector's token, except the
 * paths that let either get one.
 *
 * ```txt
 * GET  /.well-known/oauth-protected-resource             nothing: RFC 9728 metadata
 * GET  /.well-known/oauth-authorization-server/.auth     nothing: RFC 8414 metadata
 *      /.auth/...                                        Better Auth, only the routes below
 * GET  /.sign-in                                         nothing: sign in, or register from an invite
 * GET  /.allow                                           a session: approve a connector
 * POST /                                                 a token, or a session with this Origin: MCP
 * GET  /, /<app>/...                                     a session, else a redirect to /.sign-in
 * ```
 *
 * The boundary is the socket: this listener never trusts a header to say
 * where a request came from. Each request's URL is rewritten to the public
 * origin before Better Auth or the token check reads it, since the tunnel
 * delivers `http://127.0.0.1:<publicPort>/...`.
 *
 * Every authorization asks for a passkey and shows `/.allow`, and carries
 * `offline_access`, whatever the connector asked: the router forces
 * `prompt=login consent` and adds the scope, and refuses an approval
 * without it. A stored consent then never lets a request someone else
 * started finish on its own, and every code exchange starts a refresh
 * family the generation trigger checks (`authorization-server.ts`).
 */
import { createMcpProtectedRequestHandler } from '@better-auth/mcp';
import { createInsufficientScopeError } from 'better-auth/oauth2';
import {
	ALLOW_PATH,
	AUTH_BASE_PATH,
	type AuthorizationServer,
	SCOPES,
	SIGN_IN_PATH,
} from './authorization-server.ts';
import type { Site } from './http.ts';
import { isReadOnlyTool } from './mcp.ts';
import { allowPage, signInPage } from './sign-in-pages.ts';

/**
 * The Better Auth routes the sign-in uses, by method and path under `/.auth`;
 * every other route Better Auth or its plugins define answers 404. An
 * allowlist here, rather than Better Auth's `disabledPaths`, which matches
 * exact paths only and so cannot name a route with a parameter.
 */
const AUTH_ROUTES = new Set([
	'GET /oauth2/authorize',
	'POST /oauth2/token',
	'POST /oauth2/consent',
	// RFC 7009, with Better Auth's client checks: a connector's "disconnect".
	// It revokes the refresh token presented, not the grant; one presented
	// again after that ends every refresh token of the grant, as reuse does.
	'POST /oauth2/revoke',
	'GET /jwks',
	'GET /passkey/generate-register-options',
	'POST /passkey/verify-registration',
	'GET /passkey/generate-authenticate-options',
	'POST /passkey/verify-authentication',
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

const refuse = (status: number, error: string, description: string) =>
	Response.json(
		{ error, error_description: description },
		{ status, headers: { 'cache-control': 'no-store' } },
	);

/**
 * The authorization request as the router lets it reach Better Auth: a
 * passkey and `/.allow` every time, and `offline_access` always among the
 * scopes asked for. A request with no scope asks for all of them; the person
 * narrows on `/.allow`.
 */
function forcedAuthorization(request: Request) {
	const url = new URL(request.url);
	url.searchParams.set('prompt', 'login consent');
	const scopes = (url.searchParams.get('scope') ?? SCOPES.join(' '))
		.split(' ')
		.filter(Boolean);
	url.searchParams.set(
		'scope',
		[...new Set([...scopes, 'offline_access'])].join(' '),
	);
	return new Request(url, request);
}

/**
 * Why a consent POST cannot approve, or nothing when it may reach Better
 * Auth. An approval must keep `offline_access`, and the connector must be
 * able to refresh, so every grant's code exchange starts a refresh family.
 */
async function refusedConsent(
	authorization: AuthorizationServer,
	request: Request,
) {
	let body: unknown;
	try {
		body = await request.clone().json();
	} catch {
		// `/.allow` posts JSON; a body this cannot read is not checked, so it stops.
		return refuse(400, 'invalid_request', 'An approval is a JSON body');
	}
	const { accept, scope, oauth_query } = (body ?? {}) as {
		accept?: unknown;
		scope?: unknown;
		oauth_query?: unknown;
	};
	if (accept === false) return undefined;
	if (typeof scope !== 'string' || !scope.split(' ').includes('offline_access'))
		return refuse(
			400,
			'invalid_scope',
			'An approval must include offline_access',
		);
	const clientId =
		typeof oauth_query === 'string'
			? new URLSearchParams(oauth_query).get('client_id')
			: null;
	const client = authorization.db
		.query<{ grantTypes: string | null }, [string]>(
			'select grantTypes from oauthClient where clientId = ?',
		)
		.get(clientId ?? '');
	if (client && !client.grantTypes?.includes('"refresh_token"'))
		return refuse(
			400,
			'unauthorized_client',
			'This connector cannot refresh its access, which Epicenter requires',
		);
	return undefined;
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

/** The names of the tools an MCP request body calls, in one message or a batch. */
async function calledTools(request: Request): Promise<unknown[]> {
	let body: unknown;
	try {
		body = await request.clone().json();
	} catch {
		return [];
	}
	return (Array.isArray(body) ? body : [body])
		.filter(
			(message): message is { params?: { name?: unknown } } =>
				typeof message === 'object' &&
				message !== null &&
				(message as { method?: unknown }).method === 'tools/call',
		)
		.map((message) => message.params?.name);
}

/** The public listener's request handler, for `startPublicServer` and tests. */
export function publicHandler(authorization: AuthorizationServer, site: Site) {
	const { auth, origin, resource, issuer, handle } = authorization;
	const isGet = (request: Request) =>
		request.method === 'GET' || request.method === 'HEAD';
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
			if (scopes.has('write')) return site.mcp(request);
			if (!scopes.has('read')) throw createInsufficientScopeError(['read']);
			for (const name of await calledTools(request))
				if (!(await isReadOnlyTool(name)))
					throw createInsufficientScopeError(['write']);
			return site.mcp(request, true);
		},
	);
	const signedIn = async (request: Request) =>
		(await auth.api.getSession({ headers: request.headers })) !== null;
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
			if (route === 'GET /oauth2/authorize')
				return handle(forcedAuthorization(request));
			if (route === 'POST /oauth2/consent')
				return (
					(await refusedConsent(authorization, request)) ?? handle(request)
				);
			return handle(request);
		}
		if (pathname === SIGN_IN_PATH && isGet(request))
			return signInPage(authorization, request);
		if (pathname === ALLOW_PATH && isGet(request))
			return allowPage(authorization, request);
		if (pathname === '/' && request.method === 'POST') {
			// A person's own pages send their session; a cookie with any other
			// Origin, or none, counts for nothing.
			if (
				!request.headers.has('authorization') &&
				request.headers.get('origin') === origin &&
				(await signedIn(request))
			)
				return site.mcp(request);
			return withToken(request);
		}
		if (pathname.startsWith('/.')) return notFound();
		if (!isGet(request))
			return pathname === '/' ? site.launcher(request) : notFound();
		if (
			pathname === '/' &&
			request.headers.get('accept')?.includes('text/event-stream')
		)
			return site.launcher(request);
		if (!(await signedIn(request)))
			return new Response(null, {
				status: 302,
				headers: {
					location: `${SIGN_IN_PATH}?${new URLSearchParams({ next: `${pathname}${search}` })}`,
				},
			});
		return pathname === '/' ? site.launcher(request) : site.view(request);
	};
}

/** Listen on 127.0.0.1 and `port`, where a tunnel from the public address forwards. */
export function startPublicServer(
	authorization: AuthorizationServer,
	port: number,
	site: Site,
) {
	const fetch = publicHandler(authorization, site);
	return Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, fetch });
}
