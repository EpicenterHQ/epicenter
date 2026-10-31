/**
 * The OAuth 2.1 authorization server (ADR-0549) through the library's own
 * composition, in process, on a disposable Postgres cluster with every
 * migration applied: the spike's refresh lineage, grant target, and silent
 * re-authorization checks, the end-to-end flows, the refusal of a client
 * that names a metadata document, the resource check's 401 and 403 answers through a
 * test-only protected route, and the real protected mounts behind
 * `requireAccessToken` the way the deployments compose them.
 * Requires initdb, pg_ctl, and git on PATH (a push lands in a disk store);
 * never connects to a configured database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { every } from 'hono/combine';
import type { Client } from 'pg';
import { createCloudContextMiddleware } from '../create-cloud-context-middleware.js';
import { createDb, type Db } from '../db/create-db.js';
import { createDiskGitHost } from '../git-disk-store.js';
import { requireAccessToken } from '../middleware/require-auth.js';
import { mountAuthRoutes } from '../routes/auth.js';
import { type GitHost, mountGitHost } from '../routes/git.js';
import { mountInferenceApp } from '../routes/inference.js';
import { createServerApp } from '../server-app.js';
import { startDisposablePostgres } from '../test-helpers/disposable-postgres.js';
import {
	checkFlows,
	checkGrantTarget,
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
import {
	authorizeResourceRequest,
	readAccessToken,
} from './resource-access.js';

const origin = 'http://127.0.0.1:47911';
const secret = 'oauth-server-postgres-secret-0123456789';
const audiences = {
	api: origin,
	git: `${origin}/git`,
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

/** The disk Git store, recording which repositories it creates. */
const gitRoot = mkdtempSync(join(tmpdir(), 'oauth-server-git-'));
const createdRepositories: string[] = [];
const diskHost = createDiskGitHost({ root: gitRoot });
const recordingHost: GitHost = {
	...diskHost,
	async create(id) {
		createdRepositories.push(id);
		await diskHost.create(id);
	},
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
				grantTypes: ['authorization_code', 'refresh_token'],
				scopes: [
					'openid',
					'offline_access',
					'profile',
					'email',
					'ai',
					'folders:read',
					'folders:write',
				],
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

	app = createServerApp<CloudEnv>({
		resolveOrigin: () => origin,
		resolveTrustedOrigins: () => [origin],
		resolveAudiences: () => audiences,
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
	const resource = (audience: keyof typeof audiences, scope: OAuthScope) =>
		every(resourceContext, requireAccessToken({ audience, scope }));
	mountInferenceApp(app, { auth: resource('api', 'ai') });
	mountGitHost(app, {
		setup: resourceContext,
		resolveHost: () => recordingHost,
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
	rmSync(gitRoot, { recursive: true, force: true });
	await stop?.();
});

describe('checks against the library composition on Bun and Postgres', () => {
	test(
		"a refresh family is one client's grants for one person",
		() => checkRefreshFamily(harness),
		60_000,
	);
	test('end-to-end flows', () => checkFlows(harness), 60_000);
	test('grant target', () => checkGrantTarget(harness), 60_000);
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
		resource: [audiences.git],
		scope: 'offline_access folders:read',
	});
	// No client identifies itself by URL: there is no metadata document
	// support and no dynamic registration (ADR-0578).
	expect(new URL(authorized.location, origin).searchParams.get('error')).toBe(
		'invalid_client',
	);
}, 60_000);

test('one grant serves the API and Git, in any order of refreshes', async () => {
	const { client } = harness;
	const person = await client.person('audiences');
	const everyScope =
		'ai folders:read folders:write offline_access openid profile';
	const grant = await client.deviceGrant({
		clientId: cli.clientId,
		cookie: person.cookie,
		target: '*',
		scope: 'openid offline_access profile ai folders:read folders:write',
		resource: [audiences.api, audiences.git],
		redeemFor: audiences.api,
	});
	expect(grant.tokens!.scope?.split(' ').sort().join(' ')).toBe(everyScope);
	let refresh = grant.tokens!.refresh_token!;
	const at = async (token: string, audience: string, scope: OAuthScope) =>
		(
			await harness.resource(token, {
				audience,
				scope,
				namespace: person.personal,
			})
		).status;
	for (const [audience, scope] of [
		[audiences.git, 'folders:write'],
		[audiences.api, 'ai'],
		[audiences.git, 'folders:write'],
		[audiences.api, 'profile'],
	] as const) {
		const rotated = await client.token({
			grant_type: 'refresh_token',
			client_id: cli.clientId,
			refresh_token: refresh,
			resource: audience,
		});
		expect(rotated.status).toBe(200);
		// Every first-party audience allows every scope, so the grant keeps
		// them all, and each access token is still bound to its audience.
		expect(rotated.body.scope?.split(' ').sort().join(' ')).toBe(everyScope);
		const token = rotated.body.access_token;
		expect(await at(token, audience, scope)).toBe(200);
		const elsewhere =
			audience === audiences.git ? audiences.api : audiences.git;
		expect(await at(token, elsewhere, 'folders:read')).toBe(401);
		refresh = rotated.body.refresh_token!;
	}
	const stored = await sqlClient.query<{ scopes: string[] }>(
		'select scopes from oauth_refresh_token where token = $1',
		[await hashPrefixedToken(refresh, TOKEN_PREFIX.refresh)],
	);
	expect(stored.rows[0]?.scopes.sort().join(' ')).toBe(everyScope);
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
			audience: audiences.api,
			scope: 'folders:read',
			namespaceId: person.personal,
		});
		expect(foreign.error?.status).toBe(401);
		expect(foreign.error?.challenge).toContain(
			`resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
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
			namespaceId: person.personal,
			repository: null,
		});
	}, 60_000);
});

describe('the protected routes', () => {
	/** A browser app's one access token, as `createBrowserOAuth` gets it. */
	async function browserToken(resource: string, scope: string) {
		const person = await harness.client.person('routes');
		const tokens = await harness.client.codeGrant({
			...browser,
			cookie: person.cookie,
			resource: [resource],
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
	/** The first request of a push: the receive-pack advertisement. */
	const push = (token: string | null, namespace = 'aaaaaaaaaaaa') =>
		call(
			`/git/${namespace}/todos.git/info/refs?service=git-receive-pack`,
			token,
		);

	test('answer 401 with resource_metadata without a token, or with a session token', async () => {
		const person = await harness.client.person('no-token');
		const sessionToken = decodeURIComponent(
			/=([^;]+)/.exec(person.cookie)?.[1] ?? '',
		);
		for (const [response, metadata] of [
			[await inference(null), ''],
			[await push(null), '/git'],
			[await inference(sessionToken), ''],
		] as const) {
			expect(response.status).toBe(401);
			expect(response.headers.get('www-authenticate')).toBe(
				`Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource${metadata}"`,
			);
		}
	}, 60_000);

	test("answer 401 for another audience's token and 403 for a missing scope", async () => {
		const git = await browserToken(
			audiences.git,
			'openid folders:read folders:write',
		);
		// A Git token at an API route is another audience's: 401, not 403
		// (ADR-0549).
		expect((await inference(git.token)).status).toBe(401);
		const api = await browserToken(audiences.api, 'openid profile');
		expect((await push(api.token, api.person.personal)).status).toBe(401);
		const refused = await inference(api.token);
		expect(refused.status).toBe(403);
		expect(refused.headers.get('www-authenticate')).toBe(
			`Bearer error="insufficient_scope", scope="ai", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
		);
		expect(await refused.json()).toMatchObject({ error: 'insufficient_scope' });
		const readOnly = await browserToken(audiences.git, 'openid folders:read');
		expect((await push(readOnly.token, readOnly.person.personal)).status).toBe(
			403,
		);
	}, 60_000);

	test('admit a token for the audience with the scope, as its account', async () => {
		const api = await browserToken(audiences.api, 'openid profile ai');
		// The profile read is userinfo, which names the token's account.
		const read = await userinfo(api.token);
		expect(read.status).toBe(200);
		expect(await read.json()).toMatchObject({ sub: api.person.id });
		// Past the guard, the gateway reads the body: 400, not 401 or 403.
		expect((await inference(api.token)).status).toBe(400);
		const git = await browserToken(
			audiences.git,
			'openid folders:read folders:write',
		);
		const before = createdRepositories.length;
		// The advertisement of a name nobody holds is empty and creates nothing.
		const advertised = await push(git.token, git.person.personal);
		expect(advertised.status).toBe(200);
		expect(createdRepositories.length).toBe(before);
		// The push itself creates the repository.
		const pushed = await app.fetch(
			new Request(
				`${origin}/git/${git.person.personal}/todos.git/git-receive-pack`,
				{
					method: 'POST',
					headers: {
						authorization: `Bearer ${git.token}`,
						'content-type': 'application/x-git-receive-pack-request',
					},
					body: '0000',
				},
			),
		);
		expect(pushed.status).toBe(200);
		expect(createdRepositories.length).toBe(before + 1);
	}, 60_000);

	test('stop admitting a token once it is revoked or its browser session ends', async () => {
		const api = await browserToken(audiences.api, 'openid profile ai');
		// Past the guard, the gateway reads the body: 400.
		expect((await inference(api.token)).status).toBe(400);
		expect(
			await harness.client.revoke(browser.clientId, api.token, 'access_token'),
		).toBe(200);
		expect((await inference(api.token)).status).toBe(401);
		const other = await browserToken(audiences.api, 'openid profile ai');
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
			resource: [audiences.api],
			scope: 'openid profile ai',
			prompt: 'none',
		});
		expect(new URL(renewed.location).searchParams.get('code')).toBeString();
		const signedOut = await harness.client.authorize({
			...browser,
			challenge,
			resource: [audiences.api],
			scope: 'openid profile ai',
			prompt: 'none',
		});
		const answer = new URL(signedOut.location);
		expect(`${answer.origin}${answer.pathname}`).toBe(browser.redirectUri);
		expect(answer.searchParams.get('error')).toBe('login_required');
	}, 60_000);
});

describe('one browser sign-in for the API and Git (decision 65)', () => {
	const everyScope = 'openid profile ai folders:read folders:write';
	/** What `createBrowserOAuth` asks for with two resources. */
	const signInScope = `${everyScope} offline_access`;
	const at = async (
		token: string,
		audience: string,
		scope: OAuthScope,
		namespace: string,
	) => (await harness.resource(token, { audience, scope, namespace })).status;

	/** One redirect for both audiences; its code, unredeemed. */
	async function authorizeBoth(label: string) {
		const person = await harness.client.person(label);
		const { verifier, challenge } = await pkce();
		const authorized = await harness.client.authorize({
			...browser,
			cookie: person.cookie,
			challenge,
			resource: [audiences.api, audiences.git],
			scope: signInScope,
		});
		const code = new URL(authorized.location).searchParams.get('code');
		if (!code) throw new Error(`no code: ${authorized.location}`);
		return { person, code, verifier };
	}

	const redeem = (
		{ code, verifier }: { code: string; verifier: string },
		resource?: string,
	) =>
		harness.client.token({
			grant_type: 'authorization_code',
			client_id: browser.clientId,
			code,
			code_verifier: verifier,
			redirect_uri: browser.redirectUri,
			...(resource && { resource }),
		});

	/** The browser callback: exchange for the API, then refresh once for Git. */
	async function signInBoth(label: string) {
		const authorized = await authorizeBoth(label);
		const api = await redeem(authorized, audiences.api);
		expect(api.status).toBe(200);
		const git = await harness.client.token({
			grant_type: 'refresh_token',
			client_id: browser.clientId,
			refresh_token: api.body.refresh_token!,
			resource: audiences.git,
		});
		expect(git.status).toBe(200);
		return { person: authorized.person, api: api.body, git: git.body };
	}

	test('a code for both audiences and one refresh give one token per audience', async () => {
		const { person, api, git } = await signInBoth('both-audiences');
		const ns = person.personal;
		expect(await at(api.access_token, audiences.api, 'ai', ns)).toBe(200);
		expect(await at(api.access_token, audiences.git, 'folders:read', ns)).toBe(
			401,
		);
		expect(await at(git.access_token, audiences.git, 'folders:write', ns)).toBe(
			200,
		);
		expect(await at(git.access_token, audiences.api, 'ai', ns)).toBe(401);
		// The refresh never narrows the grant: both answers carry all of it.
		const sorted = (scope?: string) => scope?.split(' ').sort().join(' ');
		expect(sorted(api.scope)).toBe(sorted(signInScope));
		expect(sorted(git.scope)).toBe(sorted(signInScope));
	}, 60_000);

	test('a replayed code is refused and revokes what it issued', async () => {
		const authorized = await authorizeBoth('replay');
		const first = await redeem(authorized, audiences.api);
		expect(first.status).toBe(200);
		const replay = await redeem(authorized, audiences.git);
		expect(replay.status).toBe(400);
		expect(replay.body).toMatchObject({ error: 'invalid_grant' });
		expect(
			await at(
				first.body.access_token,
				audiences.api,
				'ai',
				authorized.person.personal,
			),
		).toBe(401);
	}, 60_000);

	test('a token for both audiences is refused at each', async () => {
		const authorized = await authorizeBoth('two-audiences');
		// Without `resource`, the library issues one token for every bound audience.
		const both = await redeem(authorized);
		expect(both.status).toBe(200);
		const ns = authorized.person.personal;
		expect(await at(both.body.access_token, audiences.api, 'ai', ns)).toBe(401);
		expect(
			await at(both.body.access_token, audiences.git, 'folders:read', ns),
		).toBe(401);
	}, 60_000);

	test('the browser grant stays bound to its session, and ends at sign-out', async () => {
		const { person, api, git } = await signInBoth('session-bound');
		const desktopGrant = await harness.client.codeGrant({
			...desktop,
			cookie: person.cookie,
			resource: [audiences.git],
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
		for (const token of [api.access_token, git.access_token])
			expect(
				await sessionOf('oauth_access_token', 'token', await accessHash(token)),
			).toBe(person.sessionId);
		expect(
			await sessionOf(
				'oauth_refresh_token',
				'token',
				await refreshHash(git.refresh_token!),
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
		const ns = person.personal;
		expect(await at(api.access_token, audiences.api, 'ai', ns)).toBe(401);
		expect(await at(git.access_token, audiences.git, 'folders:read', ns)).toBe(
			401,
		);
		const refreshed = await harness.client.token({
			grant_type: 'refresh_token',
			client_id: browser.clientId,
			refresh_token: git.refresh_token!,
			resource: audiences.api,
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
