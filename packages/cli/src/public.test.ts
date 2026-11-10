/**
 * The public listener's handler with the real authorization server, in
 * process: every request goes in as the tunnel delivers it, to
 * `http://127.0.0.1:<publicPort>`, and the site behind it is a stand-in that
 * records what reached it. Passkeys are a software authenticator running
 * Better Auth's real WebAuthn endpoints; the CIMD fetch returns Claude's
 * document. Nothing here touches the network.
 *
 * Key behaviors:
 * - each path answers by credential, and the metadata names only routes served
 * - every authorization asks for a passkey and shows /.allow, and keeps offline_access
 * - a grant is (connector, person), listed with its connections
 * - a revoke ends refresh and live access tokens at once, and no code exchange
 *   or rotation in flight across a revoke and re-approval yields a token
 * - text from a connector's metadata document is cleaned before it is shown
 *
 * See also `acceptance.public.test.ts` for serve, its private listener, and
 * `epicenter access` as processes.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ACCESS_DATABASE,
	ACCESS_KEY,
	type AuthorizationServer,
	type Grant,
	listAccess,
	openAuthorizationServer,
	type Person,
	revokeAccess,
} from './authorization-server.ts';
import type { Site } from './http.ts';
import { publicHandler } from './public.ts';
import {
	approve,
	type Browser,
	browser,
	CLAUDE_ID,
	claimsOf,
	claudeOnly,
	connectClaude as connect,
	exchangeCode,
	mcpRequest as jsonRpc,
	NAVIGATE,
	type Passkey,
	authorizeQuery as query,
	REDIRECT_URI,
	reachAllow,
	refresh as refreshWith,
	type Send,
	softwarePasskey,
} from './sign-in.test-support.ts';

setDefaultTimeout(30_000);

const PUBLIC_URL = 'https://studio.example.test:10000/';
const ORIGIN = 'https://studio.example.test:10000';
const RESOURCE = `${ORIGIN}/`;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(changes: Parameters<typeof claudeOnly>[1] = {}) {
	const folder = await realpath(
		await mkdtemp(join(tmpdir(), 'epicenter-public-')),
	);
	const fetched: string[] = [];
	const authorization = await openAuthorizationServer(
		folder,
		PUBLIC_URL,
		claudeOnly(fetched, changes),
	);
	/** What reached the site: each MCP request, and whether it was read-only. */
	const reached: {
		mcp?: { readOnly: boolean; body: unknown };
		page?: string;
	}[] = [];
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
	// Better Auth's in-memory rate limit is shared by every server in this
	// process, so each test is a different client, as the tunnel says with
	// X-Forwarded-For.
	const client = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
	/** Deliver a request to the public address as the tunnel does, to the loopback listener. */
	const send: Send = (request) => {
		const { pathname, search } = new URL(request.url);
		const delivered = new Request(
			`http://127.0.0.1:4757${pathname}${search}`,
			request,
		);
		delivered.headers.set('x-forwarded-for', client);
		return handle(delivered);
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
		const registered = await made.browser.register(
			made.passkey,
			await invite(name),
		);
		expect(registered.status).toBe(200);
		return made;
	};
	return {
		folder,
		authorization,
		send,
		reached,
		fetched,
		device,
		invite,
		signedIn,
	};
}

type Setup = Awaited<ReturnType<typeof setup>>;
type Device = { browser: Browser; passkey: Passkey };

const authorizeQuery = (scope?: string) => query(RESOURCE, scope);
const connectClaude = (t: { send: Send }, device: Device, grant: string) =>
	connect(ORIGIN, t.send, device, grant);
const refresh = (t: { send: Send }, refreshToken: string | undefined) =>
	refreshWith(ORIGIN, t.send, refreshToken);
/** Authorize and allow `grant`, leaving the code unexchanged. */
async function pendingCode(device: Device, grant: string, asked?: string) {
	const { query, verifier } = await authorizeQuery(asked);
	const code = await approve(
		device,
		await reachAllow(ORIGIN, device, query),
		grant,
	);
	return { code, verifier };
}
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

const people = (t: Setup) =>
	listAccess(t.authorization.db).filter(
		(entry): entry is Person => entry.kind === 'person',
	);
const grants = (t: Setup) =>
	listAccess(t.authorization.db).filter(
		(entry): entry is Grant => entry.kind === 'grant',
	);
/** The one grant `person` made, as `epicenter access` lists it. */
function grantOf(t: Setup, name: string) {
	const found = grants(t).filter((grant) => grant.person === name);
	expect(found).toHaveLength(1);
	return found[0] as Grant;
}

/** Wait into the next second, so a token issued now is later than a revoke made before. */
const nextSecond = () => Bun.sleep(1005 - (Date.now() % 1000));

/**
 * Hold the next refresh-token row Better Auth writes until `release`: the
 * moment after a code exchange consumed its code, or a rotation retired its
 * token, and before the new family row lands. A revoke and a re-approval
 * can run in that window.
 */
async function holdNextRefreshInsert(authorization: AuthorizationServer) {
	const { adapter } = await authorization.auth.$context;
	const create = adapter.create;
	const reached = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	adapter.create = (async (input: Parameters<typeof create>[0]) => {
		if (input.model === 'oauthRefreshToken') {
			adapter.create = create;
			reached.resolve();
			await released.promise;
		}
		return create(input);
	}) as typeof create;
	cleanups.push(async () => {
		adapter.create = create;
		released.resolve();
	});
	return { reached: reached.promise, release: () => released.resolve() };
}

/** The rows that still name `userId`, by table. */
function rowsNaming(t: Setup, userId: string) {
	const count = (sql: string) =>
		t.authorization.db.query<{ n: number }, [string]>(sql).get(userId)?.n;
	return {
		user: count('select count(*) as n from user where id = ?'),
		passkey: count('select count(*) as n from passkey where userId = ?'),
		session: count('select count(*) as n from session where userId = ?'),
		consent: count('select count(*) as n from oauthConsent where userId = ?'),
		refresh: count(
			'select count(*) as n from oauthRefreshToken where userId = ?',
		),
		access: count(
			'select count(*) as n from oauthAccessToken where userId = ?',
		),
		code: count(
			`select count(*) as n from verification
			  where json_valid(value) and json_extract(value, '$.userId') = ?`,
		),
	};
}

// ============================================================================
// The authorization server
// ============================================================================

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

	test('publishes metadata for a resource with its slash, CIMD, revocation, and no registration or introspection', async () => {
		const t = await setup();
		const resource = (await (
			await t.send(
				new Request(`${ORIGIN}/.well-known/oauth-protected-resource`),
			)
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
		expect(server.revocation_endpoint).toBe(`${ORIGIN}/.auth/oauth2/revoke`);
		expect(
			Object.keys(server).filter((field) => field.startsWith('introspection')),
		).toEqual([]);
		expect(server.grant_types_supported).toEqual([
			'authorization_code',
			'refresh_token',
		]);
		expect(server.code_challenge_methods_supported).toEqual(['S256']);
	});

	test('a verification row that is not JSON still inserts, and a code with no consent does not', async () => {
		const t = await setup();
		const { internalAdapter } = await t.authorization.auth.$context;
		const expiresAt = new Date(Date.now() + 60_000);
		// Better Auth's DPoP replay store writes values like this one.
		await internalAdapter.createVerificationValue({
			identifier: 'dpop-jti:replay',
			value: '1',
			expiresAt,
		});
		await internalAdapter.createVerificationValue({
			identifier: 'dpop-jti:text',
			value: 'not json {',
			expiresAt,
		});
		expect(
			t.authorization.db
				.query<{ n: number }, []>(
					`select count(*) as n from verification where identifier like 'dpop-jti:%'`,
				)
				.get()?.n,
		).toBe(2);
		const person = await t.signedIn();
		const [{ id: userId } = { id: '' }] = people(t);
		await expect(
			internalAdapter.createVerificationValue({
				identifier: 'a-code-with-no-consent',
				value: JSON.stringify({
					type: 'authorization_code',
					query: { client_id: CLAUDE_ID },
					userId,
				}),
				expiresAt,
			}),
		).rejects.toThrow('no consent');
		// Once the person approves, codes issue as before, and a revoke runs
		// beside rows that are not JSON.
		await connectClaude(t, person, 'read offline_access');
		revokeAccess(t.authorization.db, { kind: 'person', id: userId });
		expect(listAccess(t.authorization.db)).toEqual([]);
	});
});

// ============================================================================
// The path table
// ============================================================================

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
			[
				'GET',
				`/.auth/oauth2/public-client?client_id=${CLAUDE_ID}`,
				404,
				404,
				404,
			],
			['GET', '/.auth/oauth2/get-consents', 404, 404, 404],
			['POST', '/.auth/oauth2/register', 404, 404, 404],
			['POST', '/.auth/oauth2/introspect', 404, 404, 404],
			// Reaches Better Auth, which takes RFC 7009's form body only.
			['POST', '/.auth/oauth2/revoke', 415, 415, 415],
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
		expect((await mcpRequest(t.send, undefined, 'tools/list')).status).toBe(
			401,
		);
		expect(
			(
				await person.browser.post('/', {
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/list',
				})
			).status,
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
					cookie: person.browser.cookie(),
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
		const allow = await reachAllow(ORIGIN, person, query);
		const consent = {
			accept: true,
			scope: 'read offline_access',
			oauth_query: allow.search.slice(1),
		};
		const foreign = await person.browser.post(
			'/.auth/oauth2/consent',
			consent,
			{
				origin: 'https://evil.example',
			},
		);
		expect(foreign.status).toBe(403);
		const own = await person.browser.post('/.auth/oauth2/consent', consent);
		expect(own.status).toBe(200);
	});
});

// ============================================================================
// Authorizing a connector
// ============================================================================

describe('authorizing a connector', () => {
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
		const refreshed = await refresh(t, tokens.refresh_token);
		expect(refreshed.status).toBe(200);
		expect(refreshed.body.refresh_token).not.toBe(tokens.refresh_token);
		expect(claimsOf(refreshed.body.access_token ?? '').scope).toBe(
			'read offline_access',
		);
		expect(
			(await mcpRequest(t.send, refreshed.body.access_token, 'tools/list'))
				.status,
		).toBe(200);
	});

	test('a stored consent does not let an authorization someone else started finish: it stops at a passkey, then /.allow', async () => {
		const t = await setup();
		const owner = await t.signedIn();
		await connectClaude(t, owner, 'read write offline_access');
		// An attacker's authorization request for Claude, with their own PKCE
		// and state, loaded in the owner's signed-in browser.
		const { query } = await authorizeQuery('read write offline_access');
		const loaded = await owner.browser.get(
			`/.auth/oauth2/authorize?${query}`,
			NAVIGATE,
		);
		expect(loaded.status).toBe(302);
		const signIn = new URL(loaded.headers.get('location') ?? '', ORIGIN);
		expect(`${signIn.origin}${signIn.pathname}`).toBe(`${ORIGIN}/.sign-in`);
		expect(signIn.searchParams.get('prompt')).toBe('login consent');
		// A script with only the owner's session posts the approval itself.
		const planted = await owner.browser.post('/.auth/oauth2/consent', {
			accept: true,
			scope: 'read write offline_access',
			oauth_query: signIn.search.slice(1),
		});
		const answer = (await planted.json()) as { url?: string };
		expect(answer.url ?? '').not.toStartWith(REDIRECT_URI);
		// With the owner's passkey, it reaches /.allow and still waits there.
		const allow = await reachAllow(ORIGIN, owner, query);
		expect(allow.pathname).toBe('/.allow');
		expect(allow.searchParams.get('prompt')).toBe('consent');
	});

	test('every authorization asks for offline_access, and an approval without it is refused', async () => {
		const t = await setup();
		const person = await t.signedIn();
		const { query } = await authorizeQuery('read write');
		const allow = await reachAllow(ORIGIN, person, query);
		expect(allow.searchParams.get('scope')).toBe('read write offline_access');
		const html = await (
			await person.browser.get(`${allow.pathname}${allow.search}`)
		).text();
		expect(html).toContain('data-scope="read offline_access"');
		const oauth_query = allow.search.slice(1);
		for (const body of [
			{ accept: true, scope: 'read write', oauth_query },
			{ accept: true, oauth_query },
		]) {
			const refused = await person.browser.post('/.auth/oauth2/consent', body);
			expect(refused.status).toBe(400);
			expect(((await refused.json()) as { error: string }).error).toBe(
				'invalid_scope',
			);
		}
		expect(grants(t)).toEqual([]);
		// Denying needs no scope.
		const denied = await person.browser.post('/.auth/oauth2/consent', {
			accept: false,
			oauth_query,
		});
		expect(denied.status).toBe(200);
		expect(((await denied.json()) as { url: string }).url).toContain(
			'error=access_denied',
		);
	});

	test('a grant can only narrow what was asked', async () => {
		const t = await setup();
		const person = await t.signedIn();
		const { query } = await authorizeQuery('read write offline_access');
		const allow = await reachAllow(ORIGIN, person, query);
		const wider = await person.browser.post('/.auth/oauth2/consent', {
			accept: true,
			scope: 'read write admin offline_access',
			oauth_query: allow.search.slice(1),
		});
		expect(wider.status).toBe(400);
	});

	test('a connector whose document lists only authorization_code still starts a refresh family', async () => {
		// Better Auth lets any client allowed authorization_code refresh, so its
		// exchange inserts a refresh row and passes the generation trigger.
		const t = await setup({ grant_types: ['authorization_code'] });
		const person = await t.signedIn();
		const tokens = await connectClaude(t, person, 'read offline_access');
		expect(tokens.refresh_token).toBeString();
		expect((await refresh(t, tokens.refresh_token)).status).toBe(200);
		expect(grants(t)).toHaveLength(1);
	});

	test('/.allow leads with the host and full client_id, and strips control characters from the name the document claims', async () => {
		const t = await setup({
			client_name: 'Cl\u001b[2Jaude\u202etxt.exe\u0085\u2066',
		});
		const person = await t.signedIn();
		const { query } = await authorizeQuery();
		const allow = await reachAllow(ORIGIN, person, query);
		const html = await (
			await person.browser.get(`${allow.pathname}${allow.search}`)
		).text();
		expect(html).toContain('<h1>Allow claude.ai to use your apps?</h1>');
		expect(html).toContain(`<code>${CLAUDE_ID}</code>`);
		expect(html).toContain('It calls itself <strong>Cl[2Jaudetxt.exe</strong>');
		expect(html).toContain('only if you just started connecting it yourself');
		expect(html).not.toContain('change nothing');
		// biome-ignore lint/suspicious/noControlCharactersInRegex: finding them is the point.
		expect(html).not.toMatch(/[\u0000-\u0008\u001b\u0085\u202e\u2066]/);
		await approve(person, allow, 'read offline_access');
		expect(grantOf(t, 'phone').name).toBe('Cl[2Jaudetxt.exe');
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

	test('a write token reaches the whole site, and a forged token reaches nothing', async () => {
		const t = await setup();
		const person = await t.signedIn();
		const write = (await connectClaude(t, person, 'read write offline_access'))
			.access_token as string;
		expect(
			await (await mcpRequest(t.send, write, 'tools/list')).json(),
		).toEqual({
			readOnly: false,
		});
		expect(
			(await mcpRequest(t.send, 'eyJhbGciOiJFZERTQSJ9.e30.AAAA', 'tools/list'))
				.status,
		).toBe(401);
	});
});

// ============================================================================
// Grants: listing, narrowing, and the revocation endpoint
// ============================================================================

describe('grants', () => {
	test('one connector two people approved is two grants, each counting its connections', async () => {
		const t = await setup();
		const phone = await t.signedIn('phone');
		const laptop = await t.signedIn('laptop');
		await connectClaude(t, phone, 'read offline_access');
		// A second connection under the phone's approval, as an attacker's
		// silent re-authorization once made.
		await connectClaude(t, phone, 'read offline_access');
		await connectClaude(t, laptop, 'read write offline_access');
		const [{ id: phoneId } = { id: '' }, { id: laptopId } = { id: '' }] =
			people(t);
		expect(grants(t)).toMatchObject([
			{
				clientId: CLAUDE_ID,
				host: 'claude.ai',
				name: 'Claude',
				userId: phoneId,
				person: 'phone',
				scope: 'read offline_access',
				families: 2,
			},
			{
				clientId: CLAUDE_ID,
				userId: laptopId,
				person: 'laptop',
				scope: 'read write offline_access',
				families: 1,
			},
		]);
		expect(grantOf(t, 'phone').lastRefresh).toBeString();
	});

	test('approving narrower scopes deletes the families that hold more, and refuses their access tokens', async () => {
		const t = await setup();
		const person = await t.signedIn();
		const broad = await connectClaude(t, person, 'read write offline_access');
		const narrow = await connectClaude(t, person, 'read offline_access');
		expect(grantOf(t, 'phone')).toMatchObject({
			scope: 'read offline_access',
			families: 1,
		});
		const refused = await refresh(t, broad.refresh_token);
		expect(refused.status).toBe(400);
		expect(refused.body.error).toBe('invalid_grant');
		expect(
			(await mcpRequest(t.send, broad.access_token, 'tools/list')).status,
		).toBe(401);
		expect((await refresh(t, narrow.refresh_token)).status).toBe(200);
		expect(
			(await mcpRequest(t.send, narrow.access_token, 'tools/list')).status,
		).toBe(200);
	});

	test('POST /.auth/oauth2/revoke revokes the refresh token presented and leaves the grant', async () => {
		const t = await setup();
		const person = await t.signedIn();
		const first = await connectClaude(t, person, 'read offline_access');
		const second = await connectClaude(t, person, 'read offline_access');
		const revoked = await t.send(
			new Request(`${ORIGIN}/.auth/oauth2/revoke`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					token: first.refresh_token ?? '',
					token_type_hint: 'refresh_token',
					client_id: CLAUDE_ID,
				}),
			}),
		);
		expect(revoked.status).toBe(200);
		expect(grantOf(t, 'phone').families).toBe(1);
		expect((await refresh(t, second.refresh_token)).status).toBe(200);
		expect(grantOf(t, 'phone').families).toBe(1);
	});
});

// ============================================================================
// Revoking: rows, live tokens, and races
// ============================================================================

describe('revoking', () => {
	test('revoking a person ends their refresh, deletes every row naming them, and refuses their live access token', async () => {
		const t = await setup();
		const person = await t.signedIn('phone');
		const tokens = await connectClaude(t, person, 'read write offline_access');
		await pendingCode(person, 'read write offline_access');
		const [entry] = people(t);
		if (!entry) throw new Error('no person');
		expect(rowsNaming(t, entry.id)).toMatchObject({
			user: 1,
			passkey: 1,
			consent: 1,
			refresh: 1,
			code: 1,
		});
		revokeAccess(t.authorization.db, entry);
		const refreshed = await refresh(t, tokens.refresh_token);
		expect(refreshed.status).toBe(400);
		expect(refreshed.body.access_token).toBeUndefined();
		const call = await mcpRequest(t.send, tokens.access_token, 'tools/list');
		expect(call.status).toBe(401);
		expect(call.headers.get('www-authenticate')).toContain(
			'error="invalid_token"',
		);
		expect(rowsNaming(t, entry.id)).toEqual({
			user: 0,
			passkey: 0,
			session: 0,
			consent: 0,
			refresh: 0,
			access: 0,
			code: 0,
		});
		expect((await person.browser.get('/')).status).toBe(302);
		expect((await person.browser.signIn(person.passkey)).status).toBe(401);
		expect(listAccess(t.authorization.db)).toEqual([]);
		expect(t.reached).toEqual([]);
	});

	test("revoking one grant refuses that grant's live access token and refresh, and no other's; re-approving starts a new generation", async () => {
		const t = await setup();
		const phone = await t.signedIn('phone');
		const laptop = await t.signedIn('laptop');
		const fromPhone = await connectClaude(t, phone, 'read offline_access');
		const fromLaptop = await connectClaude(t, laptop, 'read offline_access');
		revokeAccess(t.authorization.db, grantOf(t, 'phone'));
		expect(
			(await mcpRequest(t.send, fromPhone.access_token, 'tools/list')).status,
		).toBe(401);
		expect((await refresh(t, fromPhone.refresh_token)).status).toBe(400);
		expect(
			(await mcpRequest(t.send, fromLaptop.access_token, 'tools/list')).status,
		).toBe(200);
		expect((await refresh(t, fromLaptop.refresh_token)).status).toBe(200);
		// Approved again with a passkey: the old token stays refused, a new one works.
		await nextSecond();
		const again = await connectClaude(t, phone, 'read offline_access');
		expect(
			(await mcpRequest(t.send, fromPhone.access_token, 'tools/list')).status,
		).toBe(401);
		expect(
			(await mcpRequest(t.send, again.access_token, 'tools/list')).status,
		).toBe(200);
		expect((await refresh(t, again.refresh_token)).status).toBe(200);
	});

	test('revoking a connector ends every grant of it, and its pending codes', async () => {
		const t = await setup();
		const phone = await t.signedIn('phone');
		const laptop = await t.signedIn('laptop');
		const fromPhone = await connectClaude(t, phone, 'read offline_access');
		const fromLaptop = await connectClaude(
			t,
			laptop,
			'read write offline_access',
		);
		const pending = await pendingCode(phone, 'read offline_access');
		revokeAccess(t.authorization.db, {
			kind: 'connector',
			clientId: CLAUDE_ID,
		});
		for (const tokens of [fromPhone, fromLaptop]) {
			expect((await refresh(t, tokens.refresh_token)).status).toBe(400);
			expect(
				(await mcpRequest(t.send, tokens.access_token, 'tools/list')).status,
			).toBe(401);
		}
		const exchanged = await exchangeCode(
			ORIGIN,
			t.send,
			pending.code,
			pending.verifier,
		);
		expect(exchanged.status).toBe(400);
		expect(grants(t)).toEqual([]);
		expect(people(t).map((person) => person.name)).toEqual(['phone', 'laptop']);
	});

	for (const asked of ['read write offline_access', 'read write'])
		test(`a code exchange paused across a revoke and re-approval returns no token (connector asked for ${asked})`, async () => {
			const t = await setup();
			const person = await t.signedIn();
			const paused = await pendingCode(
				person,
				'read write offline_access',
				asked,
			);
			const hold = await holdNextRefreshInsert(t.authorization);
			const exchange = exchangeCode(
				ORIGIN,
				t.send,
				paused.code,
				paused.verifier,
			);
			await Promise.race([hold.reached, exchange]);
			// The code is consumed; the family row has not landed.
			revokeAccess(t.authorization.db, grantOf(t, 'phone'));
			await nextSecond();
			const fresh = await pendingCode(
				person,
				'read write offline_access',
				asked,
			);
			hold.release();
			const old = await exchange;
			expect(old.status).toBe(400);
			expect(old.body.error).toBe('invalid_grant');
			expect(old.body.error_description).toBe('This connection was revoked');
			expect(old.body.access_token).toBeUndefined();
			expect(old.body.refresh_token).toBeUndefined();
			const now = await exchangeCode(
				ORIGIN,
				t.send,
				fresh.code,
				fresh.verifier,
			);
			expect(now.status).toBe(200);
			expect(
				(await mcpRequest(t.send, now.body.access_token, 'tools/list')).status,
			).toBe(200);
			expect(grantOf(t, 'phone').families).toBe(1);
		});

	test('a rotation paused across a revoke and re-approval returns no token', async () => {
		const t = await setup();
		const person = await t.signedIn();
		const tokens = await connectClaude(t, person, 'read write offline_access');
		const hold = await holdNextRefreshInsert(t.authorization);
		const rotation = refresh(t, tokens.refresh_token);
		await Promise.race([hold.reached, rotation]);
		// The old token is retired; its successor has not landed.
		revokeAccess(t.authorization.db, grantOf(t, 'phone'));
		await nextSecond();
		const fresh = await pendingCode(person, 'read write offline_access');
		hold.release();
		const rotated = await rotation;
		expect(rotated.status).toBe(400);
		expect(rotated.body.error).toBe('invalid_grant');
		expect(rotated.body.error_description).toBe('This connection was revoked');
		expect(rotated.body.access_token).toBeUndefined();
		expect(rotated.body.refresh_token).toBeUndefined();
		expect(
			(await exchangeCode(ORIGIN, t.send, fresh.code, fresh.verifier)).status,
		).toBe(200);
		expect(grantOf(t, 'phone').families).toBe(1);
	});
});

// ============================================================================
// People
// ============================================================================

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
		expect(listAccess(t.authorization.db)).toMatchObject([
			{ kind: 'person', name: 'phone' },
		]);
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
		expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(
			15 * 60 * 1000 - 1000,
		);
		expect(expiresAt.getTime() - before).toBeLessThanOrEqual(
			15 * 60 * 1000 + 1000,
		);
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
		const verified = await slow.browser.post(
			'/.auth/passkey/verify-registration',
			{
				createSession: true,
				response: await slow.passkey.register(await options.json()),
			},
		);
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
		expect((await other.browser.register(other.passkey, token)).status).toBe(
			200,
		);
	});

	test('a passkey signs a device in, and the sign-in page then sends it on', async () => {
		const t = await setup();
		const person = await t.signedIn();
		const laptop = {
			browser: browser(ORIGIN, t.send),
			passkey: person.passkey,
		};
		expect((await laptop.browser.get('/')).status).toBe(302);
		const signed = await laptop.browser.signIn(laptop.passkey);
		expect(signed.status).toBe(200);
		expect((await laptop.browser.get('/')).status).toBe(200);
		const page = await laptop.browser.get('/.sign-in?next=/reading/');
		expect(page.status).toBe(302);
		expect(page.headers.get('location')).toBe(`${ORIGIN}/reading/`);
		const away = await laptop.browser.get('/.sign-in?next=//evil.example/x');
		expect(away.headers.get('location')).toBe(`${ORIGIN}/`);
		const dotted = await laptop.browser.get(
			'/.sign-in?next=/.//evil.example/x',
		);
		expect(new URL(dotted.headers.get('location') ?? '').origin).toBe(ORIGIN);
	});
});
