/**
 * The public sign-in as tests drive it, with no network.
 *
 * A software passkey answers Better Auth's WebAuthn options the way a browser
 * and a platform authenticator would, with a P-256 key, `none` attestation,
 * and user presence and verification set, so the tests run the real
 * registration and sign-in endpoints. A cookie-keeping browser, Claude's
 * metadata document behind a stubbed CIMD fetch, and Claude's side of the
 * OAuth flow complete it.
 */

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const fromB64url = (text: string) =>
	new Uint8Array(Buffer.from(text, 'base64url'));
const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
	new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

/** The CBOR WebAuthn uses: unsigned and negative integers, bytes, text, and maps. */
function cbor(value: unknown): Uint8Array<ArrayBuffer> {
	const head = (major: number, length: number) => {
		if (length < 24) return Uint8Array.of((major << 5) | length);
		if (length < 0x100) return Uint8Array.of((major << 5) | 24, length);
		if (length < 0x10000)
			return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff);
		throw new Error('too long for this encoder');
	};
	if (typeof value === 'number')
		return value >= 0 ? head(0, value) : head(1, -1 - value);
	if (value instanceof Uint8Array) return concat(head(2, value.length), value);
	if (typeof value === 'string') {
		const bytes = new TextEncoder().encode(value);
		return concat(head(3, bytes.length), bytes);
	}
	if (value instanceof Map)
		return concat(
			head(5, value.size),
			...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)]),
		);
	throw new Error(`cannot encode ${typeof value}`);
}

/** An ECDSA signature as WebAuthn carries it: DER, from WebCrypto's raw r||s. */
function der(raw: Uint8Array) {
	const integer = (bytes: Uint8Array) => {
		let start = 0;
		while (start < bytes.length - 1 && bytes[start] === 0) start++;
		let trimmed = bytes.slice(start);
		if ((trimmed[0] ?? 0) & 0x80) trimmed = concat(Uint8Array.of(0), trimmed);
		return concat(Uint8Array.of(0x02, trimmed.length), trimmed);
	};
	const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
	return concat(Uint8Array.of(0x30, body.length), body);
}

/** User present, user verified. */
const FLAGS = 0x01 | 0x04;
const ATTESTED = 0x40;

type CreationOptions = {
	challenge: string;
	rp: { id: string };
	user: { id: string };
};
type RequestOptions = { challenge: string; rpId: string };

/** One passkey on one device, for `origin`. */
export async function softwarePasskey(origin: string) {
	const keys = (await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['sign', 'verify'],
	)) as CryptoKeyPair;
	const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
	const credentialId = crypto.getRandomValues(new Uint8Array(16));
	let counter = 0;
	let userHandle = '';
	const clientData = (type: string, challenge: string) =>
		new TextEncoder().encode(
			JSON.stringify({ type, challenge, origin, crossOrigin: false }),
		);
	const counterBytes = () => {
		const bytes = new Uint8Array(4);
		new DataView(bytes.buffer).setUint32(0, counter);
		return bytes;
	};
	return {
		/** The response to `generate-register-options`, as the page posts it. */
		async register(options: CreationOptions) {
			userHandle = options.user.id;
			const coseKey = new Map<number, unknown>([
				[1, 2],
				[3, -7],
				[-1, 1],
				[-2, fromB64url(jwk.x ?? '')],
				[-3, fromB64url(jwk.y ?? '')],
			]);
			const authData = concat(
				await sha256(new TextEncoder().encode(options.rp.id)),
				Uint8Array.of(FLAGS | ATTESTED),
				counterBytes(),
				new Uint8Array(16),
				Uint8Array.of(0, credentialId.length),
				credentialId,
				cbor(coseKey),
			);
			const attestationObject = cbor(
				new Map<string, unknown>([
					['fmt', 'none'],
					['attStmt', new Map()],
					['authData', authData],
				]),
			);
			return {
				id: b64url(credentialId),
				rawId: b64url(credentialId),
				type: 'public-key',
				response: {
					clientDataJSON: b64url(
						clientData('webauthn.create', options.challenge),
					),
					attestationObject: b64url(attestationObject),
					transports: ['internal'],
				},
				clientExtensionResults: {},
				authenticatorAttachment: 'platform',
			};
		},
		/** The response to `generate-authenticate-options`, as the page posts it. */
		async authenticate(options: RequestOptions) {
			counter++;
			const authData = concat(
				await sha256(new TextEncoder().encode(options.rpId)),
				Uint8Array.of(FLAGS),
				counterBytes(),
			);
			const clientDataJSON = clientData('webauthn.get', options.challenge);
			const signature = new Uint8Array(
				await crypto.subtle.sign(
					{ name: 'ECDSA', hash: 'SHA-256' },
					keys.privateKey,
					concat(authData, await sha256(clientDataJSON)),
				),
			);
			return {
				id: b64url(credentialId),
				rawId: b64url(credentialId),
				type: 'public-key',
				response: {
					clientDataJSON: b64url(clientDataJSON),
					authenticatorData: b64url(authData),
					signature: b64url(der(signature)),
					userHandle,
				},
				clientExtensionResults: {},
				authenticatorAttachment: 'platform',
			};
		},
	};
}


export type Passkey = Awaited<ReturnType<typeof softwarePasskey>>;
export type Send = (request: Request) => Promise<Response>;

/**
 * A browser at `origin`: it keeps cookies, sends its `Origin` on every POST
 * as a browser does, and navigates by hand. `send` delivers each request,
 * as the tunnel would, to whatever serves the public address.
 */
export function browser(origin: string, send: Send) {
	const jar = new Map<string, string>();
	const request = async (path: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		if (jar.size)
			headers.set(
				'cookie',
				[...jar].map(([name, value]) => `${name}=${value}`).join('; '),
			);
		if (init.method === 'POST' && !headers.has('origin'))
			headers.set('origin', origin);
		const response = await send(
			new Request(new URL(path, origin), { ...init, headers }),
		);
		for (const line of response.headers.getSetCookie()) {
			const [pair = ''] = line.split(';');
			const at = pair.indexOf('=');
			const value = pair.slice(at + 1);
			if (value === '' || /max-age=0/i.test(line)) jar.delete(pair.slice(0, at));
			else jar.set(pair.slice(0, at), value);
		}
		return response;
	};
	const get = (path: string, headers: HeadersInit = {}) =>
		request(path, { headers });
	const post = (path: string, body: unknown, headers: HeadersInit = {}) =>
		request(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify(body),
		});
	return {
		jar,
		/** The `Cookie` header this browser sends. */
		cookie: () =>
			[...jar].map(([name, value]) => `${name}=${value}`).join('; '),
		get,
		post,
		/** Register `passkey` from an invite token, as `/.sign-in?invite=` does. */
		async register(passkey: Passkey, invite: string) {
			const options = await get(
				`/.auth/passkey/generate-register-options?context=${encodeURIComponent(invite)}`,
			);
			if (!options.ok) return options;
			return post('/.auth/passkey/verify-registration', {
				createSession: true,
				response: await passkey.register(await options.json()),
			});
		},
		/** Sign in with `passkey`, continuing an authorization when `oauthQuery` is given. */
		async signIn(passkey: Passkey, oauthQuery?: string) {
			const options = await get('/.auth/passkey/generate-authenticate-options');
			return post('/.auth/passkey/verify-authentication', {
				...(oauthQuery === undefined ? {} : { oauth_query: oauthQuery }),
				response: await passkey.authenticate(await options.json()),
			});
		},
	};
}

export type Browser = ReturnType<typeof browser>;

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

/** The CIMD fetch, with no network: Claude's document, and 404 for any other. */
export function claudeOnly(fetched: string[] = []) {
	return async (input: RequestInfo | URL) => {
		const url = new Request(input).url;
		fetched.push(url);
		return url === CLAUDE_ID
			? Response.json(CLAUDE_DOC, {
					headers: { 'cache-control': 'max-age=3600' },
				})
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
export async function tokenRequest(
	origin: string,
	send: Send,
	form: Record<string, string>,
) {
	const response = await send(
		new Request(`${origin}/.auth/oauth2/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(form),
		}),
	);
	return {
		status: response.status,
		body: (await response.json()) as Record<string, string>,
	};
}

/**
 * Connect Claude from `device` and grant `grant`: authorize, sign in with
 * the passkey when there is no session, allow on `/.allow`, and exchange the
 * code. Returns the token response.
 */
export async function connectClaude(
	origin: string,
	send: Send,
	device: { browser: Browser; passkey: Passkey },
	grant: string,
) {
	const resource = `${origin}/`;
	const { query, verifier } = await authorizeQuery(resource);
	const authorized = await device.browser.get(
		`/.auth/oauth2/authorize?${query}`,
		NAVIGATE,
	);
	if (authorized.status !== 302)
		throw new Error(`authorize answered ${authorized.status}`);
	let location = new URL(authorized.headers.get('location') ?? '', origin);
	if (location.pathname === '/.sign-in') {
		const signedIn = await device.browser.signIn(
			device.passkey,
			location.search.slice(1),
		);
		if (!signedIn.ok) throw new Error(`sign-in answered ${signedIn.status}`);
		const body = (await signedIn.json()) as { redirect?: boolean; url?: string };
		if (!body.redirect || !body.url)
			throw new Error('sign-in did not continue the authorization');
		location = new URL(body.url, origin);
	}
	if (location.pathname !== '/.allow')
		throw new Error(`expected /.allow, got ${location.pathname}`);
	const page = await device.browser.get(`${location.pathname}${location.search}`);
	const html = await page.text();
	if (!page.ok || !html.includes('Claude') || !html.includes('claude.ai'))
		throw new Error(`/.allow answered ${page.status}`);
	const consent = await device.browser.post('/.auth/oauth2/consent', {
		accept: true,
		scope: grant,
		oauth_query: location.search.slice(1),
	});
	if (!consent.ok) throw new Error(`consent answered ${consent.status}`);
	const callback = new URL(((await consent.json()) as { url: string }).url);
	if (`${callback.origin}${callback.pathname}` !== REDIRECT_URI)
		throw new Error(`consent sent the browser to ${callback.href}`);
	const tokens = await tokenRequest(origin, send, {
		grant_type: 'authorization_code',
		code: callback.searchParams.get('code') ?? '',
		redirect_uri: REDIRECT_URI,
		client_id: CLAUDE_ID,
		code_verifier: verifier,
		resource,
	});
	if (tokens.status !== 200)
		throw new Error(`token answered ${tokens.status}: ${JSON.stringify(tokens.body)}`);
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
