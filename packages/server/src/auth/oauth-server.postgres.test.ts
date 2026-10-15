/**
 * The OAuth 2.1 authorization server (ADR-0549) through the library's own
 * composition, in process, on a disposable Postgres cluster with every
 * migration applied: the spike's refresh lineage, grant target, and silent
 * re-authorization checks, the end-to-end flows, a client identified by its
 * metadata document, and the resource check's 401 and 403 answers through a
 * test-only protected route.
 * Requires initdb and pg_ctl on PATH; never connects to a configured database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Client } from 'pg';
import { createCloudContextMiddleware } from '../create-cloud-context-middleware.js';
import { createDb, type Db } from '../db/create-db.js';
import { mountAuthRoutes } from '../routes/auth.js';
import { createServerApp } from '../server-app.js';
import { startDisposablePostgres } from '../test-helpers/disposable-postgres.js';
import {
	checkFlows,
	checkGrantTarget,
	checkRefreshLineage,
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
import {
	authorizeResourceRequest,
	readAccessToken,
} from './resource-access.js';

const origin = 'http://127.0.0.1:47911';
const secret = 'oauth-server-postgres-secret-0123456789';
const audiences = {
	api: origin,
	git: `${origin}/git`,
	mcp: `${origin}/mcp`,
};
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

// A client identified by its metadata document, served locally. The real
// transports refuse loopback addresses, so this one maps a public-looking
// host to the local server and still refuses redirects.
const CIMD_CLIENT_ID = 'https://cimd.example.test/client.json';
const CIMD_REDIRECT = 'http://127.0.0.1:53999/callback';
let cimdFetches = 0;
const cimdServer = Bun.serve({
	port: 0,
	hostname: '127.0.0.1',
	fetch(request) {
		cimdFetches++;
		if (new URL(request.url).pathname !== '/client.json')
			return new Response('not found', { status: 404 });
		return Response.json(
			{
				client_id: CIMD_CLIENT_ID,
				client_name: 'Example MCP Client',
				client_uri: 'https://cimd.example.test',
				redirect_uris: [CIMD_REDIRECT],
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				token_endpoint_auth_method: 'none',
				scope: 'openid offline_access folders:read folders:write ai',
			},
			{ headers: { 'cache-control': 'max-age=300' } },
		);
	},
});
const testMetadataFetch: ClientMetadataResourceFetch = (input, init) => {
	const url = new URL(
		typeof input === 'string' || input instanceof URL ? input : input.url,
	);
	if (url.host !== 'cimd.example.test')
		throw new Error(`metadata host not allowed: ${url.host}`);
	return fetch(new URL(url.pathname, cimdServer.url), {
		...init,
		redirect: 'manual',
	});
};

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
		audiences,
		clients: [
			{
				...desktop,
				name: 'Epicenter',
				redirectUris: ['http://127.0.0.1/callback'],
				grantTypes: ['authorization_code', 'refresh_token'],
				scopes: [
					'openid',
					'offline_access',
					'profile',
					'ai',
					'folders:read',
					'folders:write',
				],
				resources: [audiences.api, audiences.git],
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
				scopes: [
					'openid',
					'offline_access',
					'profile',
					'ai',
					'folders:read',
					'folders:write',
				],
				resources: [audiences.api, audiences.git],
				skipConsent: false,
				applicationType: 'native',
			},
			{
				clientId: browser.clientId,
				name: 'Todos',
				redirectUris: [browser.redirectUri],
				grantTypes: ['authorization_code'],
				scopes: ['openid', 'profile', 'ai', 'folders:read', 'folders:write'],
				resources: [audiences.api, audiences.git],
				skipConsent: true,
				applicationType: 'web',
			},
			{
				clientId: untrusted.clientId,
				name: 'Untrusted agent',
				redirectUris: ['http://127.0.0.1/callback'],
				grantTypes: ['authorization_code', 'refresh_token'],
				scopes: ['offline_access', 'folders:read', 'folders:write'],
				resources: [audiences.git],
				skipConsent: false,
				applicationType: 'native',
			},
		],
	});

	const app = createServerApp<CloudEnv>({
		resolveOrigin: () => origin,
		resolveTrustedOrigins: () => [origin],
	});
	const context = {
		connect: async () => ({ db, close: async () => {} }),
		afterResponse: () => {},
		resolveAuthSecrets: () => ({ BETTER_AUTH_SECRET: secret }),
		resolveSessionCallbacks: () => [],
	};
	mountAuthRoutes(app, {
		setup: createCloudContextMiddleware({
			...context,
			resolveOAuthServer: () => ({
				audiences,
				clientMetadataFetch: testMetadataFetch,
			}),
		}),
		serveAuthUiShell: (c) => c.html('<html>shell</html>'),
		resolveAudiences: () => audiences,
	});
	// Test-only protected route: the resource check, as every resource runs it.
	app.get('/test/resource/:namespace', async (c) => {
		const { data, error } = await authorizeResourceRequest(db, {
			token: readAccessToken(c.req.header('authorization')),
			audience: c.req.query('audience') ?? '',
			scope: (c.req.query('scope') ?? '') as OAuthScope,
			namespaceId: c.req.param('namespace'),
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
		audiences,
		desktop,
		browser,
		cli,
		untrusted,
		async resource(token, o) {
			const query = new URLSearchParams({
				audience: o.audience,
				scope: o.scope,
			});
			const authorization = o.basic
				? `Basic ${btoa(`x-access-token:${token}`)}`
				: `Bearer ${token}`;
			const response = await app.fetch(
				new Request(`${origin}/test/resource/${o.namespace}?${query}`, {
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
	cimdServer.stop(true);
	await stop?.();
});

describe('checks against the library composition on Bun and Postgres', () => {
	test('refresh lineage isolation', () => checkRefreshLineage(harness), 60_000);
	test('end-to-end flows', () => checkFlows(harness), 60_000);
	test('grant target', () => checkGrantTarget(harness), 60_000);
	test(
		'silent re-authorization',
		() => checkSilentReauthorization(harness),
		60_000,
	);
});

test('a client identified by its metadata document reaches only MCP, after consent, inside its target', async () => {
	const { client } = harness;
	const person = await client.person('cimd');
	const { verifier, challenge } = await pkce();
	const authorized = await client.authorize({
		clientId: CIMD_CLIENT_ID,
		redirectUri: CIMD_REDIRECT,
		cookie: person.cookie,
		challenge,
		resource: [audiences.mcp],
		scope: 'offline_access folders:read folders:write',
	});
	const consentPage = new URL(authorized.location, origin);
	expect(consentPage.pathname).toBe('/consent');
	const links = await sqlClient.query<{ resource_id: string }>(
		'select resource_id from oauth_client_resource where client_id = $1',
		[CIMD_CLIENT_ID],
	);
	expect(links.rows.map((row) => row.resource_id)).toEqual([audiences.mcp]);
	expect(
		(
			await client.selectTarget(person.cookie, `ns:${person.personal}`, {
				clientId: CIMD_CLIENT_ID,
			})
		).status,
	).toBe(200);
	const consented = await client.consent(
		person.cookie,
		consentPage.search.slice(1),
	);
	const code = new URL(consented.body.url ?? '').searchParams.get('code')!;
	const tokens = await client.exchange({
		clientId: CIMD_CLIENT_ID,
		redirectUri: CIMD_REDIRECT,
		code,
		verifier,
		resource: [audiences.mcp],
	});
	expect(
		(
			await harness.resource(tokens.access_token, {
				audience: audiences.mcp,
				scope: 'folders:write',
				namespace: person.personal,
			})
		).status,
	).toBe(200);
	expect(
		(
			await harness.resource(tokens.access_token, {
				audience: audiences.git,
				scope: 'folders:read',
				namespace: person.personal,
			})
		).status,
	).toBe(401);
	for (const [resource, scope] of [
		[audiences.git, 'folders:read'],
		[audiences.mcp, 'ai'],
	] as const) {
		const refused = await client.authorize({
			clientId: CIMD_CLIENT_ID,
			redirectUri: CIMD_REDIRECT,
			cookie: person.cookie,
			challenge,
			resource: [resource],
			scope,
		});
		expect(new URL(refused.location).searchParams.get('error')).toBeString();
	}
	// The metadata cache outlives the per-request Better Auth instance.
	expect(cimdFetches).toBe(1);
}, 60_000);

test('a refresh for one audience narrows that access token, not the grant', async () => {
	const { client } = harness;
	const person = await client.person('audiences');
	const grant = await client.deviceGrant({
		clientId: cli.clientId,
		cookie: person.cookie,
		target: '*',
		scope: 'openid offline_access profile ai folders:read folders:write',
		resource: [audiences.api, audiences.git],
	});
	let refresh = grant.tokens!.refresh_token!;
	// Each audience allows a different set, so the first token carries only
	// what both allow; the grant keeps all of it.
	expect(grant.tokens!.scope?.split(' ').sort()).toEqual([
		'folders:read',
		'offline_access',
		'openid',
	]);
	for (const [resource, scope] of [
		[audiences.git, 'folders:read folders:write offline_access openid'],
		[audiences.api, 'ai folders:read offline_access openid profile'],
		[audiences.git, 'folders:read folders:write offline_access openid'],
	] as const) {
		const rotated = await client.token({
			grant_type: 'refresh_token',
			client_id: cli.clientId,
			refresh_token: refresh,
			resource,
		});
		expect(rotated.status).toBe(200);
		expect(rotated.body.scope?.split(' ').sort().join(' ')).toBe(scope);
		refresh = rotated.body.refresh_token!;
	}
	const write = await harness.resource(
		(
			await client.token({
				grant_type: 'refresh_token',
				client_id: cli.clientId,
				refresh_token: refresh,
				resource: audiences.git,
			})
		).body.access_token,
		{
			audience: audiences.git,
			scope: 'folders:write',
			namespace: person.personal,
		},
	);
	expect(write.status).toBe(200);
}, 60_000);

describe('the resource check', () => {
	async function issue(scope = 'offline_access folders:read') {
		const person = await harness.client.person('resource');
		const tokens = await harness.client.codeGrant({
			...desktop,
			cookie: person.cookie,
			resource: [audiences.git],
			scope,
		});
		return { person, token: tokens.access_token };
	}
	const at = (
		token: string | null,
		namespace: string,
		scope: OAuthScope = 'folders:read',
	) =>
		authorizeResourceRequest(db, {
			token,
			audience: audiences.git,
			scope,
			namespaceId: namespace,
		});

	test('answers 401 with resource_metadata for a missing, foreign, unknown, expired, or revoked token', async () => {
		const { person, token } = await issue();
		const metadata = `resource_metadata="${origin}/.well-known/oauth-protected-resource/git"`;
		for (const presented of [
			null,
			'not-an-epicenter-token',
			`${TOKEN_PREFIX.access}unknown`,
		]) {
			const { error } = await at(presented, person.personal);
			expect(error?.status).toBe(401);
			expect(error?.challenge).toBe(
				`Bearer error="invalid_token", ${metadata}`,
			);
		}
		const hash = await hashPrefixedToken(token, TOKEN_PREFIX.access);
		await sqlClient.query(
			'update oauth_access_token set expires_at = $2 where token = $1',
			[hash, new Date(Date.now() - 1000)],
		);
		expect((await at(token, person.personal)).error?.status).toBe(401);
		const fresh = await issue();
		await sqlClient.query(
			'update oauth_access_token set revoked = $2 where token = $1',
			[await hashPrefixedToken(fresh.token, TOKEN_PREFIX.access), new Date()],
		);
		expect((await at(fresh.token, fresh.person.personal)).error?.status).toBe(
			401,
		);
		const foreign = await authorizeResourceRequest(db, {
			token: (await issue()).token,
			audience: audiences.mcp,
			scope: 'folders:read',
			namespaceId: person.personal,
		});
		expect(foreign.error?.status).toBe(401);
		expect(foreign.error?.challenge).toContain(
			`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
		);
	}, 60_000);

	test('answers 403 for a missing scope, a namespace outside the target, or no membership', async () => {
		const { person, token } = await issue('offline_access folders:read');
		const scope = await at(token, person.personal, 'folders:write');
		expect(scope.error?.status).toBe(403);
		expect(scope.error?.body.error).toBe('insufficient_scope');
		expect(scope.error?.challenge).toContain(
			'error="insufficient_scope", scope="folders:write"',
		);
		const stranger = await harness.client.person('stranger');
		const membership = await at(token, stranger.personal);
		expect(membership.error?.status).toBe(403);
		expect(membership.error?.body.error).toBe('forbidden');
		expect(membership.error?.challenge).toContain('resource_metadata=');
		await sqlClient.query(
			'update oauth_access_token set reference_id = $2 where token = $1',
			[
				await hashPrefixedToken(token, TOKEN_PREFIX.access),
				`ns:${stranger.personal}`,
			],
		);
		const outside = await at(token, person.personal);
		expect(outside.error?.status).toBe(403);
		expect(outside.error?.body.error_description).toContain('outside');
		const ok = await at(token, stranger.personal);
		expect(ok.error?.status).toBe(403);
	}, 60_000);

	test('returns the account and its role', async () => {
		const { person, token } = await issue();
		const { data } = await at(token, person.personal);
		expect(data).toEqual({
			accountId: person.id,
			role: 'owner',
			clientId: desktop.clientId,
		});
	}, 60_000);
});
