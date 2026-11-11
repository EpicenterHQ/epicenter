/**
 * A connector's authorization as tests drive it, with no network: Claude's
 * metadata document behind a stubbed CIMD fetch, Claude's side of the OAuth
 * flow at the public address, and the owner answering on the approval page,
 * which only the tailnet reaches.
 */

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

export type Send = (request: Request) => Promise<Response>;

/** Claude's metadata document, as claude.ai served it on 2026-11-11. */
export const CLAUDE_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
export const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const CLAUDE_DOC = {
	client_id: CLAUDE_ID,
	client_name: 'Claude',
	client_uri: 'https://claude.ai',
	redirect_uris: [REDIRECT_URI],
	grant_types: [
		'authorization_code',
		'refresh_token',
		'urn:ietf:params:oauth:grant-type:jwt-bearer',
	],
	response_types: ['code'],
	token_endpoint_auth_method: 'none',
};

/**
 * The CIMD fetch, with no network: Claude's document, and 404 for any other.
 * `changes` replaces fields of Claude's document, as a forged one would.
 */
export function claudeOnly(
	fetched: string[] = [],
	changes: Partial<typeof CLAUDE_DOC> = {},
) {
	return async (input: RequestInfo | URL) => {
		const url = new Request(input).url;
		fetched.push(url);
		return url === CLAUDE_ID
			? Response.json(
					{ ...CLAUDE_DOC, ...changes },
					{ headers: { 'cache-control': 'max-age=3600' } },
				)
			: new Response('Not found', { status: 404 });
	};
}

/** Navigation headers, so Better Auth answers authorize with a redirect. */
export const NAVIGATE = { accept: 'text/html', 'sec-fetch-mode': 'navigate' };

/** Claude's authorization request for `resource`, with PKCE, and its verifier. */
export async function authorizeQuery(
	resource: string,
	scope = 'read write offline_access',
) {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = b64url(
		new Uint8Array(
			await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
		),
	);
	const query = new URLSearchParams({
		response_type: 'code',
		client_id: CLAUDE_ID,
		redirect_uri: REDIRECT_URI,
		scope,
		state: 'state-1',
		code_challenge: challenge,
		code_challenge_method: 'S256',
		resource,
	});
	return { query, verifier };
}

/** Claude's server calling the token endpoint: a form post with no cookie and no Origin. */
async function tokenRequest(
	origin: string,
	send: Send,
	form: Record<string, string>,
) {
	const response = await send(
		new Request(`${origin}/oauth2/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(form),
		}),
	);
	const text = await response.text();
	let body: Record<string, string> = {};
	try {
		body = JSON.parse(text);
	} catch {}
	return { status: response.status, body };
}

/**
 * Where the public address sends a browser that starts an authorization
 * with `query`: the approval page at `tailnet`. Throws when it goes anywhere
 * else.
 */
export async function reachAllow(
	origin: string,
	send: Send,
	tailnet: string,
	query: URLSearchParams,
) {
	const authorized = await send(
		new Request(`${origin}/oauth2/authorize?${query}`, {
			headers: NAVIGATE,
		}),
	);
	if (authorized.status !== 302)
		throw new Error(`authorize answered ${authorized.status}`);
	const location = new URL(authorized.headers.get('location') ?? '');
	if (`${location.origin}${location.pathname}` !== `${tailnet}/.allow`)
		throw new Error(`expected ${tailnet}/.allow, got ${location.href}`);
	return location;
}

/**
 * The owner's answer on the approval page at `allow`, posted as its script
 * posts it, from its own origin; `tailnetSend` delivers it to the private
 * listener.
 */
export const answerAllow = (
	tailnetSend: Send,
	allow: URL,
	body: { accept: boolean; scope?: string; oauth_query?: string },
) =>
	tailnetSend(
		new Request(`${allow.origin}/.allow`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: allow.origin },
			body: JSON.stringify({ oauth_query: allow.search.slice(1), ...body }),
		}),
	);

/** Allow `grant` on the approval page at `allow`: the code Claude's callback receives. */
export async function approve(tailnetSend: Send, allow: URL, grant: string) {
	const page = await tailnetSend(new Request(allow));
	const html = await page.text();
	if (!page.ok || !html.includes('claude.ai'))
		throw new Error(`/.allow answered ${page.status}`);
	const answered = await answerAllow(tailnetSend, allow, {
		accept: true,
		scope: grant,
	});
	if (!answered.ok)
		throw new Error(
			`/.allow answered ${answered.status}: ${await answered.text()}`,
		);
	const callback = new URL(((await answered.json()) as { url: string }).url);
	if (`${callback.origin}${callback.pathname}` !== REDIRECT_URI)
		throw new Error(`the approval sent the browser to ${callback.href}`);
	return callback.searchParams.get('code') ?? '';
}

/** Claude exchanging `code` for tokens, with the PKCE `verifier` it began with. */
export const exchangeCode = (
	origin: string,
	send: Send,
	code: string,
	verifier: string,
) =>
	tokenRequest(origin, send, {
		grant_type: 'authorization_code',
		code,
		redirect_uri: REDIRECT_URI,
		client_id: CLAUDE_ID,
		code_verifier: verifier,
		resource: `${origin}/`,
	});

/** Claude refreshing with `refreshToken`. */
export const refresh = (origin: string, send: Send, refreshToken = '') =>
	tokenRequest(origin, send, {
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: CLAUDE_ID,
		resource: `${origin}/`,
	});

/** The two sides of a connection: the public address, and the approval page on the tailnet. */
export type Sides = {
	origin: string;
	send: Send;
	tailnet: string;
	tailnetSend: Send;
};

/** Authorize Claude and allow `grant`, leaving the code unexchanged. */
export async function pendingCode(sides: Sides, grant: string, asked?: string) {
	const { query, verifier } = await authorizeQuery(`${sides.origin}/`, asked);
	const allow = await reachAllow(
		sides.origin,
		sides.send,
		sides.tailnet,
		query,
	);
	const code = await approve(sides.tailnetSend, allow, grant);
	return { code, verifier };
}

/**
 * Connect Claude and grant `grant`: authorize, allow on the tailnet, and
 * exchange the code. Returns the token response.
 */
export async function connectClaude(sides: Sides, grant: string) {
	const { code, verifier } = await pendingCode(sides, grant);
	const tokens = await exchangeCode(sides.origin, sides.send, code, verifier);
	if (tokens.status !== 200)
		throw new Error(
			`token answered ${tokens.status}: ${JSON.stringify(tokens.body)}`,
		);
	return tokens.body;
}

/** A JSON-RPC request to `POST /`, as an MCP client sends it. */
export function mcpRequest(
	origin: string,
	method: string,
	params: object = {},
	headers: Record<string, string> = {},
) {
	return new Request(`${origin}/`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			...headers,
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
}

/** A JWT's claims, unverified. */
export const claimsOf = (token: string) =>
	JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
