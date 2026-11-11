/**
 * The public listener's handler and the approval page with the real
 * authorization server, in process. Every public request goes in as the
 * tunnel delivers it, to `http://127.0.0.1:<port>`, and the MCP site behind
 * it is a stand-in that records what reached it. The approval page is the
 * route the private listener answers; that listener's own rules are tested
 * in `acceptance.public.test.ts`. The CIMD fetch returns Claude's document, or ChatGPT's shape.
 * Nothing here touches the network.
 *
 * Key behaviors:
 * - the public address answers only what a connector needs, by its token
 * - every authorization goes to the approval page on the tailnet, and keeps offline_access
 * - an approval is the owner's, and a token for anyone else is refused
 * - a revoke ends refresh and live access tokens at once, and no code exchange
 *   or rotation in flight across a revoke and re-approval yields a token
 * - text from a connector's metadata document is cleaned before it is shown
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowRoute } from './allow-page.ts';
import {
	CONNECTORS_DATABASE,
	CONNECTORS_KEY,
	type AuthorizationServer,
	listGrants,
	openAuthorizationServer,
	revokeConnector,
} from './authorization-server.ts';
import {
	answerAllow,
	approve,
	CLAUDE_ID,
	claimsOf,
	claudeOnly,
	connectClaude as connect,
	exchangeCode,
	mcpRequest as jsonRpc,
	NAVIGATE,
	pendingCode as pending,
	authorizeQuery as query,
	REDIRECT_URI,
	reachAllow,
	refresh as refreshWith,
	type Send,
	type Sides,
} from './connectors.test-support.ts';
import { publicHandler } from './public.ts';

setDefaultTimeout(30_000);

const ORIGIN = 'https://studio.example.test:10000';
const RESOURCE = `${ORIGIN}/`;
const TAILNET = 'https://studio.example.test:4747';
const CONNECTORS = { url: ORIGIN, port: 4757, tailnet: TAILNET };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(
	changes: Parameters<typeof claudeOnly>[1] = {},
	fetchMetadata?: Parameters<typeof openAuthorizationServer>[2],
) {
	const folder = await realpath(
		await mkdtemp(join(tmpdir(), 'epicenter-public-')),
	);
	const fetched: string[] = [];
	const authorization = await openAuthorizationServer(
		folder,
		CONNECTORS,
		fetchMetadata ?? claudeOnly(fetched, changes),
	);
	/** What reached the MCP site, and whether it was read-only. */
	const reached: { readOnly: boolean; body: unknown }[] = [];
	const handle = publicHandler(
		authorization,
		async (request, readOnly = false) => {
			reached.push({ readOnly, body: await request.json() });
			return Response.json({ readOnly });
		},
	);
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
	/** Deliver a request to the approval page, as the private listener routes it. */
	const tailnetSend: Send = async (request) =>
		allowRoute(authorization, request);
	cleanups.push(async () => {
		authorization.close();
		await rm(folder, { recursive: true, force: true });
	});
	const sides: Sides = { origin: ORIGIN, send, tailnet: TAILNET, tailnetSend };
	return { folder, authorization, send, tailnetSend, sides, reached, fetched };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const authorizeQuery = (scope?: string) => query(RESOURCE, scope);
const connectClaude = (t: Setup, grant: string) => connect(t.sides, grant);
const pendingCode = (t: Setup, grant: string, asked?: string) =>
	pending(t.sides, grant, asked);
const refresh = (t: Setup, refreshToken: string | undefined) =>
	refreshWith(ORIGIN, t.send, refreshToken);
/** The approval page an authorization of Claude asking `scope` lands on. */
const allowFor = async (t: Setup, scope?: string) =>
	reachAllow(ORIGIN, t.send, TAILNET, (await authorizeQuery(scope)).query);
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
/** The one grant, as `epicenter connectors` lists it. */
function onlyGrant(t: Setup) {
	const found = listGrants(t.authorization.db);
	expect(found).toHaveLength(1);
	return found[0] as NonNullable<(typeof found)[0]>;
}
const ownerId = (t: Setup) =>
	t.authorization.db
		.query<{ id: string }, []>('select id from user')
		.all()
		.map((row) => row.id);

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

// ============================================================================
// The authorization server
// ============================================================================

describe('the authorization server', () => {
	test('keeps its secret and database readable only by this user, and opens again with the same owner', async () => {
		const t = await setup();
		expect((await stat(join(t.folder, CONNECTORS_KEY))).mode & 0o777).toBe(
			0o600,
		);
		expect((await stat(join(t.folder, CONNECTORS_DATABASE))).mode & 0o777).toBe(
			0o600,
		);
		const secret = await Bun.file(join(t.folder, CONNECTORS_KEY)).text();
		const owners = ownerId(t);
		expect(owners).toHaveLength(1);
		const again = await openAuthorizationServer(t.folder, CONNECTORS);
		again.close();
		expect(await Bun.file(join(t.folder, CONNECTORS_KEY)).text()).toBe(secret);
		expect(ownerId(t)).toEqual(owners);
	});

	test('publishes metadata for a resource with its slash, CIMD, revocation, and no registration or introspection', async () => {
		const t = await setup();
		const resource = (await (
			await t.send(
				new Request(`${ORIGIN}/.well-known/oauth-protected-resource`),
			)
		).json()) as Record<string, unknown>;
		expect(resource.resource).toBe(RESOURCE);
		expect(resource.authorization_servers).toEqual([ORIGIN]);
		expect(resource.scopes_supported).toEqual(['read', 'write']);
		const server = (await (
			await t.send(
				new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
			)
		).json()) as Record<string, unknown>;
		expect(server.issuer).toBe(ORIGIN);
		expect(server.client_id_metadata_document_supported).toBe(true);
		expect(server.registration_endpoint).toBeUndefined();
		expect(server.revocation_endpoint).toBe(`${ORIGIN}/oauth2/revoke`);
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
		const [userId] = ownerId(t);
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
		// Once approved, codes issue as before, and a revoke runs beside rows
		// that are not JSON.
		await connectClaude(t, 'read offline_access');
		revokeConnector(t.authorization.db, CLAUDE_ID);
		expect(listGrants(t.authorization.db)).toEqual([]);
	});
});

// ============================================================================
// The public address
// ============================================================================

describe('the public address', () => {
	test('answers only what a connector needs; everything else is 404, with a token or without', async () => {
		const t = await setup();
		const token = (await connectClaude(t, 'read write offline_access'))
			.access_token as string;
		const bearer = { authorization: `Bearer ${token}` };
		const status = async (
			method: string,
			path: string,
			headers: Record<string, string> = {},
		) =>
			(
				await t.send(
					new Request(`${ORIGIN}${path}`, {
						method,
						headers: { 'content-type': 'application/json', ...headers },
						...(method === 'POST' ? { body: '{}' } : {}),
					}),
				)
			).status;
		const cases: [string, string, number][] = [
			['GET', '/.well-known/oauth-protected-resource', 200],
			['GET', '/.well-known/oauth-authorization-server', 200],
			// The paths before the issuer was the bare origin.
			['GET', '/.well-known/oauth-authorization-server/.auth', 404],
			['GET', '/.auth/oauth2/authorize', 404],
			['GET', '/jwks', 200],
			// Reaches Better Auth, which takes RFC 7009's form body only.
			['POST', '/oauth2/revoke', 415],
			['POST', '/oauth2/consent', 404],
			['POST', '/oauth2/continue', 404],
			['GET', '/get-session', 404],
			['POST', '/sign-out', 404],
			['POST', '/sign-up/email', 404],
			['GET', '/passkey/generate-authenticate-options', 404],
			['GET', `/oauth2/public-client?client_id=${CLAUDE_ID}`, 404],
			['GET', '/oauth2/get-consents', 404],
			['POST', '/oauth2/register', 404],
			['POST', '/oauth2/introspect', 404],
			['POST', '/oauth2/create-client', 404],
			['GET', '/.well-known/openid-configuration', 404],
			['GET', '/.sign-in', 404],
			['GET', '/.allow', 404],
			['POST', '/.allow', 404],
			['GET', '/.anything', 404],
			['GET', '/', 404],
			['GET', '/reading/', 404],
			['POST', '/reading/log', 404],
		];
		const rows = [];
		for (const [method, path, expected] of cases)
			rows.push({
				route: `${method} ${path}`,
				statuses: [
					await status(method, path),
					await status(method, path, bearer),
				],
				expected: [expected, expected],
			});
		expect(rows.map((row) => [row.route, row.statuses])).toEqual(
			rows.map((row) => [row.route, row.expected]),
		);
		expect((await mcpRequest(t.send, token, 'tools/list')).status).toBe(200);
	});

	test('without a token, POST / names only the resource metadata', async () => {
		const t = await setup();
		const response = await mcpRequest(t.send, undefined, 'tools/list');
		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toBe(
			`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
		);
		expect(t.reached).toEqual([]);
	});

	test("the owner's session, as a bearer token or a cookie, approves nothing at the public address", async () => {
		const t = await setup();
		await connectClaude(t, 'read write offline_access');
		const context = await t.authorization.auth.$context;
		const [userId = ''] = ownerId(t);
		const session = await context.internalAdapter.createSession(userId);
		const { query } = await authorizeQuery();
		const credentials: Record<string, string>[] = [
			{ authorization: `Bearer ${session.token}` },
			{ cookie: `__Secure-epicenter.session_token=${session.token}` },
		];
		for (const credential of credentials) {
			const authorized = await t.send(
				new Request(`${ORIGIN}/oauth2/authorize?${query}`, {
					headers: { ...NAVIGATE, ...credential },
				}),
			);
			const location = authorized.headers.get('location') ?? '';
			expect(location).toStartWith(`${TAILNET}/.allow?`);
			expect(location).not.toContain('code=');
		}
	});
});

// ============================================================================
// Authorizing a connector
// ============================================================================

describe('authorizing a connector', () => {
	test('the whole flow: authorize, the approval page on the tailnet, a token for the resource, refresh', async () => {
		const t = await setup();
		const tokens = await connectClaude(t, 'read offline_access');
		expect(t.fetched).toEqual([CLAUDE_ID]);
		expect(tokens.scope).toBe('read offline_access');
		expect(tokens.expires_in).toBe(900 as unknown as string);
		expect(tokens.refresh_token).toBeString();
		const claims = claimsOf(tokens.access_token ?? '');
		expect(claims).toMatchObject({
			aud: RESOURCE,
			iss: ORIGIN,
			azp: CLAUDE_ID,
			sub: ownerId(t)[0],
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

	test("an approval's session lasts only as long as its code, and the next approval clears expired ones", async () => {
		const t = await setup();
		await connectClaude(t, 'read offline_access');
		const sessions = () =>
			t.authorization.db
				.query<{ expiresAt: string | number; createdAt: string | number }, []>(
					'select expiresAt, createdAt from session',
				)
				.all()
				.map(
					(row) =>
						new Date(row.expiresAt).getTime() -
						new Date(row.createdAt).getTime(),
				);
		const [lasts = 0] = sessions();
		expect(sessions()).toHaveLength(1);
		expect(Math.abs(lasts - 10 * 60_000)).toBeLessThan(2_000);
		t.authorization.db.run(`update session set expiresAt = ?`, [
			new Date(Date.now() - 1000).toISOString(),
		]);
		await connectClaude(t, 'read offline_access');
		expect(sessions()).toHaveLength(1);
	});

	test('a stored consent never finishes an authorization on its own: each goes to the approval page', async () => {
		const t = await setup();
		await connectClaude(t, 'read write offline_access');
		// Someone else's authorization request for Claude, with their own PKCE
		// and state.
		const allow = await allowFor(t, 'read write offline_access');
		expect(allow.searchParams.get('prompt')).toBe('consent');
		expect(allow.searchParams.has('sig')).toBe(true);
	});

	test('every authorization asks for offline_access, and an approval without it is refused', async () => {
		const t = await setup();
		const allow = await allowFor(t, 'read write');
		expect(allow.searchParams.get('scope')).toBe('read write offline_access');
		const html = await (await t.tailnetSend(new Request(allow))).text();
		expect(html).toContain('data-scope="read offline_access"');
		for (const body of [
			{ accept: true, scope: 'read write' },
			{ accept: true },
		]) {
			const refused = await answerAllow(t.tailnetSend, allow, body);
			expect(refused.status).toBe(400);
			expect(((await refused.json()) as { message: string }).message).toBe(
				'An approval must include offline_access',
			);
		}
		expect(listGrants(t.authorization.db)).toEqual([]);
		// Denying needs no scope.
		const denied = await answerAllow(t.tailnetSend, allow, { accept: false });
		expect(denied.status).toBe(200);
		const url = ((await denied.json()) as { url: string }).url;
		expect(url).toStartWith(REDIRECT_URI);
		expect(url).toContain('error=access_denied');
	});

	test('a grant can only narrow what was asked', async () => {
		const t = await setup();
		const allow = await allowFor(t, 'read offline_access');
		const wider = await answerAllow(t.tailnetSend, allow, {
			accept: true,
			scope: 'read write offline_access',
		});
		expect(wider.status).toBe(400);
		expect(listGrants(t.authorization.db)).toEqual([]);
	});

	test('a query that is changed, unsigned, or missing approves nothing', async () => {
		const t = await setup();
		const allow = await allowFor(t, 'read offline_access');
		const answer = (oauth_query: string) =>
			answerAllow(t.tailnetSend, allow, {
				accept: true,
				scope: 'read offline_access',
				oauth_query,
			});
		const changed = allow.search
			.slice(1)
			.replace(
				encodeURIComponent(REDIRECT_URI),
				encodeURIComponent('https://evil.example/cb'),
			);
		expect(changed).not.toBe(allow.search.slice(1));
		expect((await answer(changed)).status).toBe(400);
		const unsigned = new URLSearchParams(allow.search);
		unsigned.delete('sig');
		expect((await answer(unsigned.toString())).status).toBe(400);
		const missing = await t.tailnetSend(
			new Request(`${TAILNET}/.allow`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ accept: true, scope: 'read offline_access' }),
			}),
		);
		expect(missing.status).toBe(400);
		expect(listGrants(t.authorization.db)).toEqual([]);
		const page = await t.tailnetSend(
			new Request(`${TAILNET}/.allow?client_id=${CLAUDE_ID}`),
		);
		expect(page.status).toBe(400);
	});

	test('a connector whose document lists only authorization_code still starts a refresh family', async () => {
		// Better Auth lets any client allowed authorization_code refresh, so its
		// exchange inserts a refresh row and passes the generation trigger.
		const t = await setup({ grant_types: ['authorization_code'] });
		const tokens = await connectClaude(t, 'read offline_access');
		expect(tokens.refresh_token).toBeString();
		expect((await refresh(t, tokens.refresh_token)).status).toBe(200);
		expect(listGrants(t.authorization.db)).toHaveLength(1);
	});

	test('the approval page leads with the host and full client_id, and strips control characters from the name the document claims', async () => {
		const t = await setup({
			client_name: 'Cl\u001b[2Jaude‮txt.exe\u0085⁦',
		});
		const allow = await allowFor(t);
		const html = await (await t.tailnetSend(new Request(allow))).text();
		expect(html).toContain('<h1>Allow claude.ai to use your apps?</h1>');
		expect(html).toContain(`<code>${CLAUDE_ID}</code>`);
		expect(html).toContain('It calls itself <strong>Cl[2Jaudetxt.exe</strong>');
		expect(html).toContain('only if you just started connecting it yourself');
		// biome-ignore lint/suspicious/noControlCharactersInRegex: finding them is the point.
		expect(html).not.toMatch(/[\u0000-\u0008\u001b\u0085‮⁦]/);
		await approve(t.tailnetSend, allow, 'read offline_access');
		expect(onlyGrant(t).name).toBe('Cl[2Jaudetxt.exe');
	});

	test('a read token lists and calls only through the read-only site', async () => {
		const t = await setup();
		const token = (await connectClaude(t, 'read offline_access'))
			.access_token as string;
		const listed = await mcpRequest(t.send, token, 'tools/list');
		expect(listed.status).toBe(200);
		expect(await listed.json()).toEqual({ readOnly: true });
		// The read-only site refuses a write action (acceptance.public.test.ts);
		// the handler only routes the call there.
		const call = await mcpRequest(t.send, token, 'tools/call', {
			name: 'reading_log',
			arguments: {},
		});
		expect(await call.json()).toEqual({ readOnly: true });
		expect(t.reached.map((each) => each.readOnly)).toEqual([true, true]);
	});

	test('a write token reaches the whole site, and a forged token reaches nothing', async () => {
		const t = await setup();
		const write = (await connectClaude(t, 'read write offline_access'))
			.access_token as string;
		expect(
			await (await mcpRequest(t.send, write, 'tools/list')).json(),
		).toEqual({ readOnly: false });
		expect(
			(await mcpRequest(t.send, 'eyJhbGciOiJFZERTQSJ9.e30.AAAA', 'tools/list'))
				.status,
		).toBe(401);
	});

	test("a grant is live only for the owner: a token whose subject is anyone else's is refused", async () => {
		const t = await setup();
		const tokens = await connectClaude(t, 'read offline_access');
		const claims = claimsOf(tokens.access_token ?? '');
		expect(t.authorization.isGrantLive(claims)).toBe(true);
		expect(
			t.authorization.isGrantLive({ ...claims, sub: 'someone-else' }),
		).toBe(false);
	});

	test('a grant someone other than the owner holds, as one from before ADR-0881, is not listed, and revoking its connector deletes it', async () => {
		const t = await setup();
		await connectClaude(t, 'read offline_access');
		t.authorization.db.exec(`update oauthConsent set userId = 'someone-else'`);
		expect(listGrants(t.authorization.db)).toEqual([]);
		revokeConnector(t.authorization.db, CLAUDE_ID);
		expect(
			t.authorization.db.query('select count(*) as n from oauthConsent').get(),
		).toEqual({ n: 0 });
	});
});

// ============================================================================
// Grants: listing, narrowing, and the revocation endpoint
// ============================================================================

describe('grants', () => {
	test('a connector is one grant, counting each connection under it', async () => {
		const t = await setup();
		await connectClaude(t, 'read offline_access');
		await connectClaude(t, 'read offline_access');
		expect(listGrants(t.authorization.db)).toMatchObject([
			{
				clientId: CLAUDE_ID,
				host: 'claude.ai',
				name: 'Claude',
				scope: 'read offline_access',
				families: 2,
			},
		]);
		expect(onlyGrant(t).lastRefresh).toBeString();
	});

	test('approving narrower scopes deletes the families that hold more, and refuses their access tokens', async () => {
		const t = await setup();
		const broad = await connectClaude(t, 'read write offline_access');
		const narrow = await connectClaude(t, 'read offline_access');
		expect(onlyGrant(t)).toMatchObject({
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

	test('a rotation that read a broad family before a narrowing inserts no family broader than the consent', async () => {
		const t = await setup();
		await connectClaude(t, 'read write offline_access');
		const db = t.authorization.db;
		const broad = db.query('select * from oauthRefreshToken').get() as Record<
			string,
			unknown
		>;
		await connectClaude(t, 'read offline_access');
		// What the in-flight rotation writes after the narrowing: its successor,
		// still holding write.
		const successor = {
			...broad,
			id: 'in-flight',
			token: 'in-flight',
		};
		const columns = Object.keys(successor);
		expect(() =>
			db
				.query(
					`insert into oauthRefreshToken (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
				)
				.run(...(Object.values(successor) as string[])),
		).toThrow('this grant was revoked');
	});

	test('POST /oauth2/revoke revokes the refresh token presented and leaves the grant', async () => {
		const t = await setup();
		const first = await connectClaude(t, 'read offline_access');
		const second = await connectClaude(t, 'read offline_access');
		const revoked = await t.send(
			new Request(`${ORIGIN}/oauth2/revoke`, {
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
		expect(onlyGrant(t).families).toBe(1);
		expect((await refresh(t, second.refresh_token)).status).toBe(200);
		expect(onlyGrant(t).families).toBe(1);
	});
});

// ============================================================================
// Revoking: rows, live tokens, and races
// ============================================================================

describe('revoking', () => {
	test('revoking a connector ends its refresh, its live access tokens, and its pending codes, and keeps the owner', async () => {
		const t = await setup();
		const tokens = await connectClaude(t, 'read write offline_access');
		const code = await pendingCode(t, 'read write offline_access');
		revokeConnector(t.authorization.db, CLAUDE_ID);
		const refreshed = await refresh(t, tokens.refresh_token);
		expect(refreshed.status).toBe(400);
		expect(refreshed.body.access_token).toBeUndefined();
		const call = await mcpRequest(t.send, tokens.access_token, 'tools/list');
		expect(call.status).toBe(401);
		expect(call.headers.get('www-authenticate')).toContain(
			'error="invalid_token"',
		);
		expect(
			(await exchangeCode(ORIGIN, t.send, code.code, code.verifier)).status,
		).toBe(400);
		expect(listGrants(t.authorization.db)).toEqual([]);
		expect(ownerId(t)).toHaveLength(1);
		expect(t.reached).toEqual([]);
	});

	test('approving again after a revoke starts a new generation; the old token stays refused', async () => {
		const t = await setup();
		const before = await connectClaude(t, 'read offline_access');
		revokeConnector(t.authorization.db, CLAUDE_ID);
		await nextSecond();
		const again = await connectClaude(t, 'read offline_access');
		expect(
			(await mcpRequest(t.send, before.access_token, 'tools/list')).status,
		).toBe(401);
		expect((await refresh(t, before.refresh_token)).status).toBe(400);
		expect(
			(await mcpRequest(t.send, again.access_token, 'tools/list')).status,
		).toBe(200);
		expect((await refresh(t, again.refresh_token)).status).toBe(200);
	});

	for (const asked of ['read write offline_access', 'read write'])
		test(`a code exchange paused across a revoke and re-approval returns no token (connector asked for ${asked})`, async () => {
			const t = await setup();
			const paused = await pendingCode(t, 'read write offline_access', asked);
			const hold = await holdNextRefreshInsert(t.authorization);
			const exchange = exchangeCode(
				ORIGIN,
				t.send,
				paused.code,
				paused.verifier,
			);
			await Promise.race([hold.reached, exchange]);
			// The code is consumed; the family row has not landed.
			revokeConnector(t.authorization.db, CLAUDE_ID);
			await nextSecond();
			const fresh = await pendingCode(t, 'read write offline_access', asked);
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
			expect(onlyGrant(t).families).toBe(1);
		});

	test('a rotation paused across a revoke and re-approval returns no token', async () => {
		const t = await setup();
		const tokens = await connectClaude(t, 'read write offline_access');
		const hold = await holdNextRefreshInsert(t.authorization);
		const rotation = refresh(t, tokens.refresh_token);
		await Promise.race([hold.reached, rotation]);
		// The old token is retired; its successor has not landed.
		revokeConnector(t.authorization.db, CLAUDE_ID);
		await nextSecond();
		const fresh = await pendingCode(t, 'read write offline_access');
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
		expect(onlyGrant(t).families).toBe(1);
	});
});

// ============================================================================
// ChatGPT: a connector that authenticates with private_key_jwt
// ============================================================================

describe('a connector that authenticates with private_key_jwt, as ChatGPT does', () => {
	/** The shape of ChatGPT's metadata document, as chatgpt.com served one on 2026-11-12. */
	const CHATGPT_ID = 'https://chatgpt.com/oauth/test-instance/client.json';
	const CHATGPT_REDIRECT = 'https://chatgpt.com/connector/oauth/test-instance';
	const JWKS_URI = 'https://chatgpt.com/oauth/jwks.json';
	const CLIENT_ASSERTION_TYPE =
		'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

	async function chatgpt() {
		const keys = (await crypto.subtle.generateKey(
			{
				name: 'RSASSA-PKCS1-v1_5',
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: 'SHA-256',
			},
			true,
			['sign', 'verify'],
		)) as CryptoKeyPair;
		const jwk = {
			...(await crypto.subtle.exportKey('jwk', keys.publicKey)),
			kid: 'chatgpt-1',
			use: 'sig',
			alg: 'RS256',
		};
		const fetchMetadata = async (input: RequestInfo | URL) => {
			const url = new Request(input).url;
			if (url === CHATGPT_ID)
				return Response.json({
					client_id: CHATGPT_ID,
					client_uri: 'https://chatgpt.com/',
					redirect_uris: [CHATGPT_REDIRECT],
					token_endpoint_auth_method: 'private_key_jwt',
					token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
					grant_types: ['authorization_code', 'refresh_token'],
					response_types: ['code'],
					client_name: 'ChatGPT',
					token_endpoint_auth_signing_alg: 'RS256',
					jwks_uri: JWKS_URI,
				});
			if (url === JWKS_URI) return Response.json({ keys: [jwk] });
			return new Response('Not found', { status: 404 });
		};
		/** A client assertion signed with ChatGPT's key, for the token endpoint. */
		const assertion = async () => {
			const encode = (value: object) =>
				Buffer.from(JSON.stringify(value)).toString('base64url');
			const now = Math.floor(Date.now() / 1000);
			const input = `${encode({ alg: 'RS256', kid: 'chatgpt-1', typ: 'JWT' })}.${encode(
				{
					iss: CHATGPT_ID,
					sub: CHATGPT_ID,
					aud: `${ORIGIN}/oauth2/token`,
					iat: now,
					exp: now + 300,
					jti: crypto.randomUUID(),
				},
			)}`;
			const signature = await crypto.subtle.sign(
				'RSASSA-PKCS1-v1_5',
				keys.privateKey,
				new TextEncoder().encode(input),
			);
			return `${input}.${Buffer.from(signature).toString('base64url')}`;
		};
		return { fetchMetadata, assertion };
	}

	const token = async (t: Setup, form: Record<string, string>) => {
		const response = await t.send(
			new Request(`${ORIGIN}/oauth2/token`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams(form),
			}),
		);
		return {
			status: response.status,
			body: (await response.json().catch(() => ({}))) as Record<string, string>,
		};
	};

	/** ChatGPT's authorization, approved for `grant`: the code and its verifier. */
	async function approved(t: Setup, grant: string) {
		const { query: asked, verifier } = await query(RESOURCE, grant);
		asked.set('client_id', CHATGPT_ID);
		asked.set('redirect_uri', CHATGPT_REDIRECT);
		const allow = await reachAllow(ORIGIN, t.send, TAILNET, asked);
		const page = await t.tailnetSend(new Request(allow));
		expect(await page.text()).toContain('Allow chatgpt.com to use your apps?');
		const answered = await answerAllow(t.tailnetSend, allow, {
			accept: true,
			scope: grant,
		});
		expect(answered.status).toBe(200);
		const callback = new URL(((await answered.json()) as { url: string }).url);
		expect(`${callback.origin}${callback.pathname}`).toBe(CHATGPT_REDIRECT);
		return { code: callback.searchParams.get('code') ?? '', verifier };
	}

	test('connects with a signed client assertion, calls, and refreshes; without one, its code is refused', async () => {
		const { fetchMetadata, assertion } = await chatgpt();
		const t = await setup({}, fetchMetadata);
		const first = await approved(t, 'read offline_access');
		const unsigned = await token(t, {
			grant_type: 'authorization_code',
			code: first.code,
			redirect_uri: CHATGPT_REDIRECT,
			client_id: CHATGPT_ID,
			code_verifier: first.verifier,
			resource: RESOURCE,
		});
		expect(unsigned.body.error).toBe('invalid_client');

		const { code, verifier } = await approved(t, 'read offline_access');
		const exchanged = await token(t, {
			grant_type: 'authorization_code',
			code,
			redirect_uri: CHATGPT_REDIRECT,
			client_id: CHATGPT_ID,
			code_verifier: verifier,
			resource: RESOURCE,
			client_assertion_type: CLIENT_ASSERTION_TYPE,
			client_assertion: await assertion(),
		});
		expect(exchanged.status).toBe(200);
		expect(
			(await mcpRequest(t.send, exchanged.body.access_token, 'tools/list'))
				.status,
		).toBe(200);
		const refreshed = await token(t, {
			grant_type: 'refresh_token',
			refresh_token: exchanged.body.refresh_token ?? '',
			client_id: CHATGPT_ID,
			resource: RESOURCE,
			client_assertion_type: CLIENT_ASSERTION_TYPE,
			client_assertion: await assertion(),
		});
		expect(refreshed.status).toBe(200);
		expect(listGrants(t.authorization.db)).toMatchObject([
			{ clientId: CHATGPT_ID, host: 'chatgpt.com', name: 'ChatGPT' },
		]);
	});
});
