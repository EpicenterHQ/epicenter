/**
 * The public listener's handler with the real authorization server, in
 * process: every request goes in as the tunnel delivers it, to
 * `http://127.0.0.1:<publicPort>`, and the site behind it is a stand-in that
 * records what reached it. Passkeys are a software authenticator running
 * Better Auth's real WebAuthn endpoints; the CIMD fetch returns Claude's
 * document. Nothing here touches the network.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ACCESS_DATABASE,
	ACCESS_KEY,
	listAccess,
	openAuthorizationServer,
	revokeAccess,
} from './authorization-server.ts';
import type { Site } from './http.ts';
import { publicHandler } from './public.ts';
import {
	type Browser,
	browser,
	CLAUDE_ID,
	claimsOf,
	claudeOnly,
	connectClaude as connect,
	authorizeQuery as query,
	mcpRequest as jsonRpc,
	NAVIGATE,
	type Passkey,
	REDIRECT_URI,
	type Send,
	softwarePasskey,
	tokenRequest as token,
} from './sign-in.test-support.ts';

setDefaultTimeout(30_000);

const PUBLIC_URL = 'https://studio.example.test:10000/';
const ORIGIN = 'https://studio.example.test:10000';
const RESOURCE = `${ORIGIN}/`;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
	const folder = await realpath(
		await mkdtemp(join(tmpdir(), 'epicenter-public-')),
	);
	const fetched: string[] = [];
	const authorization = await openAuthorizationServer(
		folder,
		PUBLIC_URL,
		claudeOnly(fetched),
	);
	/** What reached the site: each MCP request, and whether it was read-only. */
	const reached: { mcp?: { readOnly: boolean; body: unknown }; page?: string }[] =
		[];
	const site: Site = {
		async mcp(request, readOnly = false) {
			reached.push({ mcp: { readOnly, body: await request.json() } });
			return Response.json({ readOnly });
		},
		async launcher() {
			reached.push({ page: 'launcher' });
			return new Response('launcher');
		},
		async view(request) {
			reached.push({ page: new URL(request.url).pathname });
			return new Response('view');
		},
	};
	const handle = publicHandler(authorization, site);
	/** Deliver a request to the public address as the tunnel does, to the loopback listener. */
	const send: Send = (request) => {
		const { pathname, search } = new URL(request.url);
		return handle(
			new Request(`http://127.0.0.1:4757${pathname}${search}`, request),
		);
	};
	cleanups.push(async () => {
		authorization.close();
		await rm(folder, { recursive: true, force: true });
	});
	/** A new device: a browser and the passkey on it. */
	const device = async () => ({
		browser: browser(ORIGIN, send),
		passkey: await softwarePasskey(ORIGIN),
	});
	/** An invite's token, as `epicenter access invite` prints it in a link. */
	const invite = async (name = 'phone') =>
		new URL((await authorization.invite(name)).url).searchParams.get(
			'invite',
		) as string;
	/** A device that has registered its passkey from an invite, and so is signed in. */
	const signedIn = async (name = 'phone') => {
		const made = await device();
		const registered = await made.browser.register(made.passkey, await invite(name));
		expect(registered.status).toBe(200);
		return made;
	};
	return { folder, authorization, send, reached, fetched, device, invite, signedIn };
}

const authorizeQuery = (scope?: string) => query(RESOURCE, scope);
const tokenRequest = (send: Send, form: Record<string, string>) =>
	token(ORIGIN, send, form);
const connectClaude = (
	t: { send: Send },
	device: { browser: Browser; passkey: Passkey },
	grant: string,
) => connect(ORIGIN, t.send, device, grant);
/** Claude's MCP request, with its access token when there is one. */
const mcpRequest = (
	send: Send,
	accessToken: string | undefined,
	method: string,
	params: object = {},
) =>
	send(
		jsonRpc(
			ORIGIN,
			method,
			params,
			accessToken ? { authorization: `Bearer ${accessToken}` } : {},
		),
	);


describe('the authorization server', () => {
	test('keeps its secret and database readable only by this user, and opens again unchanged', async () => {
		const t = await setup();
		expect((await stat(join(t.folder, ACCESS_KEY))).mode & 0o777).toBe(0o600);
		expect((await stat(join(t.folder, ACCESS_DATABASE))).mode & 0o777).toBe(
			0o600,
		);
		const secret = await Bun.file(join(t.folder, ACCESS_KEY)).text();
		const again = await openAuthorizationServer(t.folder, PUBLIC_URL);
		again.close();
		expect(await Bun.file(join(t.folder, ACCESS_KEY)).text()).toBe(secret);
	});

	test('publishes metadata for a resource with its slash, read and write, CIMD, and no registration', async () => {
		const t = await setup();
		const resource = (await (
			await t.send(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`))
		).json()) as Record<string, unknown>;
		expect(resource.resource).toBe(RESOURCE);
		expect(resource.authorization_servers).toEqual([`${ORIGIN}/.auth`]);
		expect(resource.scopes_supported).toEqual(['read', 'write']);
		const server = (await (
			await t.send(
				new Request(`${ORIGIN}/.well-known/oauth-authorization-server/.auth`),
			)
		).json()) as Record<string, unknown>;
		expect(server.issuer).toBe(`${ORIGIN}/.auth`);
		expect(server.client_id_metadata_document_supported).toBe(true);
		expect(server.registration_endpoint).toBeUndefined();
		expect(server.grant_types_supported).toEqual([
			'authorization_code',
			'refresh_token',
		]);
		expect(server.code_challenge_methods_supported).toEqual(['S256']);
	});
});

describe('the path table', () => {
	test('each path answers by credential: none, a session, a token', async () => {
		const t = await setup();
		const person = await t.signedIn();
		const token = (await connectClaude(t, person, 'read write offline_access'))
			.access_token as string;
		const none = browser(ORIGIN, t.send);
		const bearer = { authorization: `Bearer ${token}` };
		const status = async (
			who: ReturnType<typeof browser>,
			method: string,
			path: string,
			headers: Record<string, string> = {},
		) =>
			(
				await (method === 'GET'
					? who.get(path, headers)
					: who.post(path, {}, headers))
			).status;
		const cases: [string, string, number, number, number][] = [
			// method, path, no credential, a session, a token
			['GET', '/.well-known/oauth-protected-resource', 200, 200, 200],
			['GET', '/.well-known/oauth-authorization-server/.auth', 200, 200, 200],
			['GET', '/.well-known/oauth-authorization-server', 404, 404, 404],
			['GET', '/.auth/jwks', 200, 200, 200],
			['GET', '/.auth/get-session', 404, 404, 404],
			['POST', '/.auth/sign-out', 404, 404, 404],
			['POST', '/.auth/sign-up/email', 404, 404, 404],
			['POST', '/.auth/update-user', 404, 404, 404],
			['GET', '/.auth/list-sessions', 404, 404, 404],
			['GET', '/.auth/passkey/list-user-passkeys', 404, 404, 404],
			['GET', `/.auth/oauth2/public-client?client_id=${CLAUDE_ID}`, 404, 404, 404],
			['GET', '/.auth/oauth2/get-consents', 404, 404, 404],
			['POST', '/.auth/oauth2/register', 404, 404, 404],
			['POST', '/.auth/oauth2/introspect', 404, 404, 404],
			['POST', '/.auth/oauth2/revoke', 404, 404, 404],
			['POST', '/.auth/oauth2/create-client', 404, 404, 404],
			['GET', '/.auth/admin/oauth2/resources/x', 404, 404, 404],
			['GET', '/.auth/.well-known/oauth-authorization-server', 404, 404, 404],
			['GET', '/.sign-in', 200, 302, 200],
			['GET', '/.allow', 302, 400, 302],
			['GET', '/.anything', 404, 404, 404],
			['GET', '/', 302, 200, 302],
			['GET', '/reading/', 302, 200, 302],
		];
		const rows = [];
		for (const [method, path, ...expected] of cases)
			rows.push({
				route: `${method} ${path}`,
				statuses: [
					await status(none, method, path),
					await status(person.browser, method, path),
					await status(none, method, path, bearer),
				],
				expected,
			});
		expect(rows.map((row) => [row.route, row.statuses])).toEqual(
			rows.map((row) => [row.route, row.expected]),
		);
		// POST / is MCP: a session counts only from the public origin's own pages.
		expect((await mcpRequest(t.send, undefined, 'tools/list')).status).toBe(401);
		expect(
			(await person.browser.post('/', { jsonrpc: '2.0', id: 1, method: 'tools/list' }))
				.status,
		).toBe(200);
		expect((await mcpRequest(t.send, token, 'tools/list')).status).toBe(200);
	});

	test('without a credential, POST / names only the resource metadata, and a page redirects to sign in', async () => {
		const t = await setup();
		const response = await mcpRequest(t.send, undefined, 'tools/list');
		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toBe(
			`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
		);
		const page = await t.send(new Request(`${ORIGIN}/reading/books?x=1`));
		expect(page.status).toBe(302);
		expect(page.headers.get('location')).toBe(
			`/.sign-in?next=${encodeURIComponent('/reading/books?x=1')}`,
		);
		expect(t.reached).toEqual([]);
	});

	test('a session cookie on POST / with a foreign Origin, or none, is refused', async () => {
		const t = await setup();
		const person = await t.signedIn();
		const call = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
		const foreign = await person.browser.post('/', call, {
			origin: 'https://evil.example',
		});
		expect(foreign.status).toBe(401);
		const sameHostOtherPort = await person.browser.post('/', call, {
			origin: 'https://studio.example.test',
		});
		expect(sameHostOtherPort.status).toBe(401);
		const noOrigin = await t.send(
			new Request(`${ORIGIN}/`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					cookie: [...person.browser.jar]
						.map(([name, value]) => `${name}=${value}`)
						.join('; '),
				},
				body: JSON.stringify(call),
			}),
		);
		expect(noOrigin.status).toBe(401);
		expect(t.reached).toEqual([]);
		const own = await person.browser.post('/', call);
		expect(own.status).toBe(200);
		expect(t.reached).toEqual([{ mcp: { readOnly: false, body: call } }]);
	});

	test('Better Auth refuses a consent posted from a foreign Origin', async () => {
		const t = await setup();
		const person = await t.signedIn();
		const { query } = await authorizeQuery('read offline_access');
		const allow = new URL(
			(await person.browser.get(`/.auth/oauth2/authorize?${query}`, NAVIGATE))
				.headers.get('location') ?? '',
			ORIGIN,
		);
		const consent = { accept: true, oauth_query: allow.search.slice(1) };
		const foreign = await person.browser.post('/.auth/oauth2/consent', consent, {
			origin: 'https://evil.example',
		});
		expect(foreign.status).toBe(403);
		const own = await person.browser.post('/.auth/oauth2/consent', consent);
		expect(own.status).toBe(200);
	});
});

describe('connectors', () => {
	test('the whole flow: authorize, sign in with a passkey, allow reading, a token for the resource, refresh', async () => {
		const t = await setup();
		const person = await t.signedIn();
		// The same passkey in a browser with no session, as a synced passkey is.
		const fresh = { browser: browser(ORIGIN, t.send), passkey: person.passkey };
		const tokens = await connectClaude(t, fresh, 'read offline_access');
		expect(t.fetched).toEqual([CLAUDE_ID]);
		expect(tokens.scope).toBe('read offline_access');
		expect(tokens.expires_in).toBe(900 as unknown as string);
		expect(tokens.refresh_token).toBeString();
		const claims = claimsOf(tokens.access_token ?? '');
		expect(claims).toMatchObject({
			aud: RESOURCE,
			iss: `${ORIGIN}/.auth`,
			azp: CLAUDE_ID,
			scope: 'read offline_access',
		});
		expect(claims.exp - claims.iat).toBe(900);
		const refreshed = await tokenRequest(t.send, {
			grant_type: 'refresh_token',
			refresh_token: tokens.refresh_token ?? '',
			client_id: CLAUDE_ID,
			resource: RESOURCE,
		});
		expect(refreshed.status).toBe(200);
		expect(refreshed.body.refresh_token).not.toBe(tokens.refresh_token);
		expect(claimsOf(refreshed.body.access_token ?? '').scope).toBe(
			'read offline_access',
		);
	});

	test('a grant can only narrow what was asked', async () => {
		const t = await setup();
		const person = await t.signedIn();
		const { query } = await authorizeQuery('read write offline_access');
		const allow = new URL(
			(await person.browser.get(`/.auth/oauth2/authorize?${query}`, NAVIGATE))
				.headers.get('location') ?? '',
			ORIGIN,
		);
		expect(allow.pathname).toBe('/.allow');
		const wider = await person.browser.post('/.auth/oauth2/consent', {
			accept: true,
			scope: 'read write admin',
			oauth_query: allow.search.slice(1),
		});
		expect(wider.status).toBe(400);
	});

	test('a read token lists and calls only through the read-only site, and anything else asks for write', async () => {
		const t = await setup();
		const person = await t.signedIn();
		const token = (await connectClaude(t, person, 'read offline_access'))
			.access_token as string;
		const listed = await mcpRequest(t.send, token, 'tools/list');
		expect(listed.status).toBe(200);
		expect(await listed.json()).toEqual({ readOnly: true });
		// A tool name that is not an app's read-only action: here, a command.
		const call = await mcpRequest(t.send, token, 'tools/call', {
			name: 'access_revoke_claude',
			arguments: {},
		});
		expect(call.status).toBe(403);
		const challenge = call.headers.get('www-authenticate') ?? '';
		expect(challenge).toContain('error="insufficient_scope"');
		expect(challenge).toContain('scope="write"');
		expect(t.reached.map((each) => each.mcp?.readOnly)).toEqual([true]);
	});

	test('a write token reaches the whole site, and a token with neither scope reaches nothing', async () => {
		const t = await setup();
		const person = await t.signedIn();
		const write = (await connectClaude(t, person, 'read write offline_access'))
			.access_token as string;
		expect(await (await mcpRequest(t.send, write, 'tools/list')).json()).toEqual({
			readOnly: false,
		});
		const other = await t.device();
		const registered = await other.browser.register(
			other.passkey,
			await t.invite('tablet'),
		);
		expect(registered.status).toBe(200);
		const none = (await connectClaude(t, other, 'offline_access'))
			.access_token as string;
		const refused = await mcpRequest(t.send, none, 'tools/list');
		expect(refused.status).toBe(403);
		expect(refused.headers.get('www-authenticate')).toContain('scope="read"');
		expect(
			(await mcpRequest(t.send, 'eyJhbGciOiJFZERTQSJ9.e30.AAAA', 'tools/list'))
				.status,
		).toBe(401);
	});

	test('revoking a connector ends its refresh and its unexchanged codes; its access token lasts until it expires', async () => {
		const t = await setup();
		const person = await t.signedIn();
		const tokens = await connectClaude(t, person, 'read offline_access');
		// A code issued and not yet exchanged when the revoke happens.
		const { query, verifier } = await authorizeQuery('read offline_access');
		const pending = new URL(
			(await person.browser.get(`/.auth/oauth2/authorize?${query}`, NAVIGATE))
				.headers.get('location') ?? '',
		);
		expect(`${pending.origin}${pending.pathname}`).toBe(REDIRECT_URI);
		const [connector] = listAccess(t.authorization.db).filter(
			(entry) => entry.kind === 'connector',
		);
		expect(connector).toMatchObject({
			name: 'Claude',
			host: 'claude.ai',
			scope: 'read offline_access',
		});
		if (!connector) throw new Error('no connector');
		revokeAccess(t.authorization.db, connector);
		const refreshed = await tokenRequest(t.send, {
			grant_type: 'refresh_token',
			refresh_token: tokens.refresh_token ?? '',
			client_id: CLAUDE_ID,
			resource: RESOURCE,
		});
		expect(refreshed.status).toBe(400);
		expect(refreshed.body.error).toBe('invalid_grant');
		const exchanged = await tokenRequest(t.send, {
			grant_type: 'authorization_code',
			code: pending.searchParams.get('code') ?? '',
			redirect_uri: REDIRECT_URI,
			client_id: CLAUDE_ID,
			code_verifier: verifier,
			resource: RESOURCE,
		});
		expect(exchanged.status).toBe(400);
		expect(
			(await mcpRequest(t.send, tokens.access_token, 'tools/list')).status,
		).toBe(200);
		expect(listAccess(t.authorization.db).map((entry) => entry.kind)).toEqual([
			'person',
		]);
		// Connecting again asks the person again.
		const { query: again } = await authorizeQuery('read offline_access');
		const asked = new URL(
			(await person.browser.get(`/.auth/oauth2/authorize?${again}`, NAVIGATE))
				.headers.get('location') ?? '',
			ORIGIN,
		);
		expect(asked.pathname).toBe('/.allow');
	});

	test('a connector two people approved is one entry, and revoking it ends both grants', async () => {
		const t = await setup();
		const phone = await t.signedIn('phone');
		const laptop = await t.signedIn('laptop');
		const fromPhone = await connectClaude(t, phone, 'read offline_access');
		const fromLaptop = await connectClaude(t, laptop, 'read write offline_access');
		const connectors = listAccess(t.authorization.db).filter(
			(entry) => entry.kind === 'connector',
		);
		expect(connectors).toHaveLength(1);
		expect(connectors[0]).toMatchObject({
			name: 'Claude',
			scope: 'read write offline_access',
		});
		if (!connectors[0]) throw new Error('no connector');
		revokeAccess(t.authorization.db, connectors[0]);
		for (const tokens of [fromPhone, fromLaptop]) {
			const refreshed = await tokenRequest(t.send, {
				grant_type: 'refresh_token',
				refresh_token: tokens.refresh_token ?? '',
				client_id: CLAUDE_ID,
				resource: RESOURCE,
			});
			expect(refreshed.status).toBe(400);
		}
	});
});

describe('people', () => {
	test('an invite registers one passkey once, as a new person, and signs that device in', async () => {
		const t = await setup();
		const token = await t.invite('phone');
		const first = await t.device();
		const registered = await first.browser.register(first.passkey, token);
		expect(registered.status).toBe(200);
		expect((await first.browser.get('/')).status).toBe(200);
		const second = await t.device();
		expect((await second.browser.register(second.passkey, token)).status).toBe(
			401,
		);
		const people = listAccess(t.authorization.db);
		expect(people).toMatchObject([{ kind: 'person', name: 'phone' }]);
		const email = t.authorization.db
			.query<{ email: string }, []>('select email from user')
			.get()?.email;
		expect(email).toEndWith('@epicenter.invalid');
	});

	test('two registrations begun from one invite end with one passkey', async () => {
		const t = await setup();
		const token = await t.invite();
		const a = await t.device();
		const b = await t.device();
		const optionsA = await a.browser.get(
			`/.auth/passkey/generate-register-options?context=${token}`,
		);
		const optionsB = await b.browser.get(
			`/.auth/passkey/generate-register-options?context=${token}`,
		);
		expect([optionsA.status, optionsB.status]).toEqual([200, 200]);
		const [verifiedA, verifiedB] = await Promise.all([
			a.browser.post('/.auth/passkey/verify-registration', {
				createSession: true,
				response: await a.passkey.register(await optionsA.json()),
			}),
			b.browser.post('/.auth/passkey/verify-registration', {
				createSession: true,
				response: await b.passkey.register(await optionsB.json()),
			}),
		]);
		expect([verifiedA.status, verifiedB.status].sort()).toEqual([200, 401]);
		expect(
			t.authorization.db
				.query<{ n: number }, []>('select count(*) as n from passkey')
				.get()?.n,
		).toBe(1);
	});

	test('an invite expires after 15 minutes, even between its options and its verification', async () => {
		const t = await setup();
		const before = Date.now();
		const { expiresAt } = await t.authorization.invite('phone');
		expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(15 * 60 * 1000 - 1000);
		expect(expiresAt.getTime() - before).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
		const expire = () =>
			t.authorization.db
				.query('update verification set expiresAt = ? where identifier like ?')
				.run(new Date(Date.now() - 1000).toISOString(), 'epicenter-invite:%');
		const token = await t.invite();
		expire();
		const late = await t.device();
		expect((await late.browser.register(late.passkey, token)).status).toBe(401);
		const token2 = await t.invite();
		const slow = await t.device();
		const options = await slow.browser.get(
			`/.auth/passkey/generate-register-options?context=${token2}`,
		);
		expect(options.status).toBe(200);
		expire();
		const verified = await slow.browser.post('/.auth/passkey/verify-registration', {
			createSession: true,
			response: await slow.passkey.register(await options.json()),
		});
		expect(verified.status).toBe(401);
		expect(listAccess(t.authorization.db)).toEqual([]);
	});

	test('without an invite, or from a signed-in device, no passkey is registered', async () => {
		const t = await setup();
		const nobody = await t.device();
		expect(
			(await nobody.browser.get('/.auth/passkey/generate-register-options'))
				.status,
		).toBe(401);
		const person = await t.signedIn();
		const token = await t.invite('second');
		const extra = await softwarePasskey(ORIGIN);
		expect((await person.browser.register(extra, token)).status).toBe(403);
		expect(listAccess(t.authorization.db).length).toBe(1);
		// The refused registration did not use the invite up.
		const other = await t.device();
		expect((await other.browser.register(other.passkey, token)).status).toBe(200);
	});

	test('revoking a person ends their sessions and their passkey', async () => {
		const t = await setup();
		const person = await t.signedIn('phone');
		const [entry] = listAccess(t.authorization.db);
		if (!entry) throw new Error('no person');
		revokeAccess(t.authorization.db, entry);
		expect((await person.browser.get('/')).status).toBe(302);
		const again = await person.browser.signIn(person.passkey);
		expect(again.status).toBe(401);
		expect(listAccess(t.authorization.db)).toEqual([]);
	});

	test('a passkey signs a device in, and the sign-in page then sends it on', async () => {
		const t = await setup();
		const person = await t.signedIn();
		const laptop = { browser: browser(ORIGIN, t.send), passkey: person.passkey };
		expect((await laptop.browser.get('/')).status).toBe(302);
		const signed = await laptop.browser.signIn(laptop.passkey);
		expect(signed.status).toBe(200);
		expect((await laptop.browser.get('/')).status).toBe(200);
		const page = await laptop.browser.get('/.sign-in?next=/reading/');
		expect(page.status).toBe(302);
		expect(page.headers.get('location')).toBe(`${ORIGIN}/reading/`);
		const away = await laptop.browser.get('/.sign-in?next=//evil.example/x');
		expect(away.headers.get('location')).toBe(`${ORIGIN}/`);
		const dotted = await laptop.browser.get('/.sign-in?next=/.//evil.example/x');
		expect(new URL(dotted.headers.get('location') ?? '').origin).toBe(ORIGIN);
	});
});
