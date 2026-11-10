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
 */
import { createMcpProtectedRequestHandler } from '@better-auth/mcp';
import { createInsufficientScopeError } from 'better-auth/oauth2';
import {
	ALLOW_PATH,
	AUTH_BASE_PATH,
	type AuthorizationServer,
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

const notFound = () => new Response('Not found', { status: 404 });

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
	const { auth, origin, resource, issuer } = authorization;
	const isGet = (request: Request) =>
		request.method === 'GET' || request.method === 'HEAD';
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
		if (METADATA_PATHS.has(pathname)) return auth.handler(request);
		if (pathname.startsWith(`${AUTH_BASE_PATH}/`))
			return AUTH_ROUTES.has(
				`${request.method} ${pathname.slice(AUTH_BASE_PATH.length)}`,
			)
				? auth.handler(request)
				: notFound();
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
