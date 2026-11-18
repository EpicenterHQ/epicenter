/**
 * The OAuth 2.1 authorization server (ADR-0549) through the library's own
 * composition, in process, on a disposable Postgres cluster with every
 * migration applied: the spike's refresh lineage, consent, and silent
 * re-authorization checks, the end-to-end flows, the refusal of a client
 * that names a metadata document, the resource check's 401 and 403 answers through a
 * test-only route, and the inference mount behind
 * `requireAccessToken` the way the deployments compose them.
 * Requires initdb and pg_ctl on PATH. It
 * never connects to a configured database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { every } from 'hono/combine';
import type { Client } from 'pg';
import { createCloudContextMiddleware } from '../create-cloud-context-middleware.js';
import { createDb, type Db } from '../db/create-db.js';
import { requireAccessToken } from '../middleware/require-auth.js';
import { mountAuthRoutes } from '../routes/auth.js';
import { mountInferenceApp } from '../routes/inference.js';
import { createServerApp } from '../server-app.js';
import { startDisposablePostgres } from '../test-helpers/disposable-postgres.js';
import {
	checkConsent,
	checkFlows,
	checkRefreshFamily,
	checkSilentReauthorization,
	type OAuthHarness,
} from '../test-helpers/oauth-checks.js';
import { OAuthTestClient, pkce } from '../test-helpers/oauth-client.js';
import type { CloudEnv } from '../types.js';
import {
	hashPrefixedToken,
	type OAuthScope,
	TOKEN_PREFIX,
} from './oauth-policy.js';
import { registerFirstPartyClients } from './oauth-registrations.js';
import { authorizeAccountRequest, readAccessToken } from './resource-access.js';

const origin = 'http://127.0.0.1:47911';
const secret = 'oauth-server-postgres-secret-0123456789';
const desktop = {
	clientId: 'so.epicenter',
	redirectUri: 'http://127.0.0.1:53111/callback',
};
const browser = {
	clientId: 'so.epicenter.todos',
	redirectUri: 'https://todos.example.test/auth/callback',
};
const cli = { clientId: 'so.epicenter.cli' };
const untrusted = {
	clientId: 'test.untrusted',
	redirectUri: 'http://127.0.0.1:53222/callback',
};

let app: ReturnType<typeof createServerApp<CloudEnv>>;
let stop: () => Promise<void>;
let sqlClient: Client;
let db: Db;
let harness: OAuthHarness;

beforeAll(async () => {
	const cluster = await startDisposablePostgres();
	stop = cluster.stop;
	sqlClient = cluster.clients[0];
	db = createDb(sqlClient);
	await migrate(db, {
		migrationsFolder: fileURLToPath(
			new URL('../../../../apps/api/drizzle/', import.meta.url),
		),
	});
	await registerFirstPartyClients(db, {
		origin,
		clients: [
			{
				...desktop,
				name: 'Epicenter',
				redirectUris: ['http://127.0.0.1/callback'],
				grantTypes: ['authorization_code', 'refresh_token'],
				scopes: ['openid', 'offline_access', 'profile', 'ai'],
				resources: [origin],
				skipConsent: true,
				applicationType: 'native',
			},
			{
				...cli,
				name: 'Epicenter CLI',
				redirectUris: [],
				grantTypes: [
					'urn:ietf:params:oauth:grant-type:device_code',
					'refresh_token',
				],
				scopes: ['openid', 'offline_access', 'profile', 'ai'],
				resources: [origin],
				skipConsent: false,
				applicationType: 'native',
			},
			{
				clientId: browser.clientId,
				name: 'Todos',
				redirectUris: [browser.redirectUri],
				grantTypes: ['authorization_code', 'refresh_token'],
				scopes: ['openid', 'offline_access', 'profile', 'email', 'ai'],
				resources: [origin],
				skipConsent: true,
				applicationType: 'web',
			},
			{
				clientId: untrusted.clientId,
				name: 'Untrusted agent',
				redirectUris: ['http://127.0.0.1/callback'],
				grantTypes: ['authorization_code', 'refresh_token'],
				scopes: ['offline_access', 'profile'],
				resources: [origin],
				skipConsent: false,
				applicationType: 'native',
			},
		],
	});

	app = createServerApp<CloudEnv>({
		resolveOrigin: () => origin,
		resolveTrustedOrigins: () => [origin],
	});
	const context = {
		connect: async () => ({ db, close: async () => {} }),
		afterResponse: () => {},
		resolveAuthSecrets: () => ({ BETTER_AUTH_SECRET: secret }),
	};
	mountAuthRoutes(app, {
		setup: createCloudContextMiddleware({
			...context,
			oauthServer: true,
		}),
		serveAuthUiShell: (c) => c.html('<html>shell</html>'),
	});
	// The real protected mounts, guarded the way both deployments guard them.
	const resourceContext = createCloudContextMiddleware(context);
	mountInferenceApp(app, {
		auth: every(resourceContext, requireAccessToken({ scope: 'ai' })),
	});
	// Test-only protected route: the resource check, as every resource runs it.
	app.get('/test/resource', async (c) => {
		const { data, error } = await authorizeAccountRequest(db, {
			token: readAccessToken(c.req.header('authorization')),
			audience: c.req.query('audience') ?? '',
			scope: (c.req.query('scope') ?? '') as OAuthScope,
		});
		if (error)
			return c.json(error.body, error.status, {
				'WWW-Authenticate': error.challenge,
			});
		return c.json(data);
	});

	const client = new OAuthTestClient(
		origin,
		sqlClient,
		secret,
		async (url, init) => app.fetch(new Request(url, init)),
	);
	harness = {
		client,
		desktop,
		browser,
		cli,
		untrusted,
		async resource(token, o) {
			const query = new URLSearchParams({
				audience: o.audience,
				scope: o.scope,
			});
			const authorization = `Bearer ${token}`;
			const response = await app.fetch(
				new Request(`${origin}/test/resource?${query}`, {
					headers: { authorization },
				}),
			);
			return {
				status: response.status,
				challenge: response.headers.get('www-authenticate'),
				body: (await response.json()) as never,
			};
		},
	};
}, 60_000);

afterAll(async () => {
	await stop?.();
});

describe('checks against the library composition on Bun and Postgres', () => {
	test(
		"a refresh family is one client's grants for one person",
		() => checkRefreshFamily(harness),
		60_000,
	);
	test('end-to-end flows', () => checkFlows(harness), 60_000);
	test('consent', () => checkConsent(harness), 60_000);
	test(
		'silent re-authorization',
		() => checkSilentReauthorization(harness),
		60_000,
	);
});

test('a client that names a metadata document is unknown', async () => {
	const { client } = harness;
	const person = await client.person('metadata-document');
	const { challenge } = await pkce();
	const authorized = await client.authorize({
		clientId: 'https://client.example.test/client.json',
		redirectUri: 'http://127.0.0.1:53999/callback',
		cookie: person.cookie,
		challenge,
		resource: [origin],
		scope: 'offline_access profile',
	});
	// No client identifies itself by URL: there is no metadata document
	// support and no dynamic registration (ADR-0578).
	expect(new URL(authorized.location, origin).searchParams.get('error')).toBe(
		'invalid_client',
	);
}, 60_000);

describe('the protected routes', () => {
	/** A browser grant for the API origin. */
	async function browserToken(scope: string) {
		const person = await harness.client.person('routes');
		const tokens = await harness.client.codeGrant({
			...browser,
			cookie: person.cookie,
			resource: [origin],
			scope,
		});
		return { person, token: tokens.access_token };
	}
	const call = (
		path: string,
		token: string | null,
		init: { method?: string; body?: unknown } = {},
	) =>
		app.fetch(
			new Request(`${origin}${path}`, {
				method: init.method ?? 'GET',
				headers: {
					// A browser names its origin on every cross-origin request.
					origin,
					...(token ? { authorization: `Bearer ${token}` } : {}),
					...(init.body ? { 'content-type': 'application/json' } : {}),
				},
				body: init.body ? JSON.stringify(init.body) : undefined,
			}),
		);
	const userinfo = (token: string | null) =>
		call('/auth/oauth2/userinfo', token);
	const inference = (token: string | null) =>
		call('/v1/chat/completions', token, { method: 'POST', body: {} });

	test('answer 401 with resource_metadata without a token, or with a session token', async () => {
		const person = await harness.client.person('no-token');
		const sessionToken = decodeURIComponent(
			/=([^;]+)/.exec(person.cookie)?.[1] ?? '',
		);
		for (const response of [
			await inference(null),
			await inference(sessionToken),
		]) {
			expect(response.status).toBe(401);
			expect(response.headers.get('www-authenticate')).toBe(
				`Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
			);
		}
	}, 60_000);

	test('inference answers 403 when the token lacks its scope', async () => {
		const api = await browserToken('openid profile');
		const refused = await inference(api.token);
		expect(refused.status).toBe(403);
		expect(refused.headers.get('www-authenticate')).toBe(
			`Bearer error="insufficient_scope", scope="ai", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
		);
		expect(await refused.json()).toMatchObject({ error: 'insufficient_scope' });
	}, 60_000);

	test('admit a token for the audience with the scope, as its account', async () => {
		const api = await browserToken('openid profile ai');
		// The profile read is userinfo, which names the token's account.
		const read = await userinfo(api.token);
		expect(read.status).toBe(200);
		expect(await read.json()).toMatchObject({ sub: api.person.id });
		// Past the guard, the gateway reads the body: 400, not 401 or 403.
		expect((await inference(api.token)).status).toBe(400);
	}, 60_000);

	test('stop admitting a token once it is revoked or its browser session ends', async () => {
		const api = await browserToken('openid profile ai');
		// Past the guard, the gateway reads the body: 400.
		expect((await inference(api.token)).status).toBe(400);
		expect(
			await harness.client.revoke(browser.clientId, api.token, 'access_token'),
		).toBe(200);
		expect((await inference(api.token)).status).toBe(401);
		const other = await browserToken('openid profile ai');
		await sqlClient.query(
			'update session set expires_at = $2 where user_id = $1',
			[other.person.id, new Date(Date.now() - 1000)],
		);
		expect((await inference(other.token)).status).toBe(401);
	}, 60_000);

	test('a browser renews silently with prompt=none while its session lasts', async () => {
		const person = await harness.client.person('renewal');
		const { challenge } = await pkce();
		const renewed = await harness.client.authorize({
			...browser,
			challenge,
			cookie: person.cookie,
			resource: [origin],
			scope: 'openid profile ai',
			prompt: 'none',
		});
		expect(new URL(renewed.location).searchParams.get('code')).toBeString();
		const signedOut = await harness.client.authorize({
			...browser,
			challenge,
			resource: [origin],
			scope: 'openid profile ai',
			prompt: 'none',
		});
		const answer = new URL(signedOut.location);
		expect(`${answer.origin}${answer.pathname}`).toBe(browser.redirectUri);
		expect(answer.searchParams.get('error')).toBe('login_required');
	}, 60_000);
});

describe('browser grants with offline_access', () => {
	test('the browser grant stays bound to its session, and ends at sign-out', async () => {
		const person = await harness.client.person('session-bound');
		const api = await harness.client.codeGrant({
			...browser,
			cookie: person.cookie,
			resource: [origin],
			scope: 'openid profile ai offline_access',
		});
		const desktopGrant = await harness.client.codeGrant({
			...desktop,
			cookie: person.cookie,
			resource: [origin],
		});
		const sessionOf = async (table: string, column: string, token: string) =>
			(
				await sqlClient.query<{ session_id: string | null }>(
					`select session_id from ${table} where ${column} = $1`,
					[token],
				)
			).rows[0]?.session_id;
		const accessHash = async (token: string) =>
			(await hashPrefixedToken(token, TOKEN_PREFIX.access))!;
		const refreshHash = async (token: string) =>
			(await hashPrefixedToken(token, TOKEN_PREFIX.refresh))!;
		expect(
			await sessionOf(
				'oauth_access_token',
				'token',
				await accessHash(api.access_token),
			),
		).toBe(person.sessionId);
		expect(
			await sessionOf(
				'oauth_refresh_token',
				'token',
				await refreshHash(api.refresh_token!),
			),
		).toBe(person.sessionId);
		// The desktop app's offline grant is still detached from the session.
		expect(
			await sessionOf(
				'oauth_refresh_token',
				'token',
				await refreshHash(desktopGrant.refresh_token!),
			),
		).toBeNull();

		const signedOut = await harness.client.request('/auth/sign-out', {
			cookie: person.cookie,
			json: {},
		});
		expect(signedOut.status).toBe(200);
		expect(
			(
				await harness.resource(api.access_token, {
					audience: origin,
					scope: 'ai',
				})
			).status,
		).toBe(401);
		const refreshed = await harness.client.token({
			grant_type: 'refresh_token',
			client_id: browser.clientId,
			refresh_token: api.refresh_token!,
			resource: origin,
		});
		expect(refreshed.status).toBe(400);
		expect(refreshed.body).toMatchObject({ error: 'invalid_grant' });
		expect(
			(
				await harness.client.refresh(
					desktop.clientId,
					desktopGrant.refresh_token!,
				)
			).status,
		).toBe(200);
	}, 60_000);
});
