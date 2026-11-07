/**
 * The CLI's sign-in against the real authorization server (ADR-0549,
 * ADR-0558): `@epicenter/server`'s composition in process, on a disposable
 * Postgres cluster with every migration applied, registering the CLI's
 * client and the Epicenter app's as the hosted deployment does. The CLI
 * reaches it through an injected `fetch`; a person's approval is simulated
 * through the consent page's requests, as the server's checks do. The app's
 * sign-in, which its shell holds, is played by the server's test client, to
 * show that each program's refresh-token family is its own. The keychain is
 * a store in memory. Requires initdb and pg_ctl on PATH; never connects to a
 * configured database.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOAuthAudiences } from '@epicenter/definition/site';
import {
	authorizeAccountRequest,
	type CloudEnv,
	createCloudContextMiddleware,
	createDb,
	createServerApp,
	mountAuthRoutes,
	type OAuthScope,
	registerFirstPartyClients,
} from '@epicenter/server/bun';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Client } from 'pg';
import { startDisposablePostgres } from '../../server/src/test-helpers/disposable-postgres.js';
import {
	OAuthTestClient,
	type Person,
} from '../../server/src/test-helpers/oauth-client.js';
import {
	type AuthContext,
	accessToken,
	authStatus,
	type DeviceCode,
	loginWithDevice,
	logout,
	readGrant,
	resolveDeployment,
	type StoredGrant,
} from './auth.ts';
import { createMemorySecrets, type SecretStore } from './secrets.ts';

const origin = 'http://127.0.0.1:47913';
const secret = 'cli-auth-postgres-secret-0123456789abc';
const audiences = resolveOAuthAudiences(origin);
const deployment = resolveDeployment(origin);
const everyScope: OAuthScope[] = [
	'openid',
	'offline_access',
	'profile',
	'ai',
	'folders:read',
	'folders:write',
	'folders:all',
];

let stopPostgres: () => Promise<void>;
let sql: Client;
let db: ReturnType<typeof createDb>;
let app: ReturnType<typeof createServerApp<CloudEnv>>;
let client: OAuthTestClient;
let scratch: string;

/** Every request the CLI sent, by path and grant type. */
const sent: { path: string; grantType: string | null }[] = [];

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), 'epicenter-cli-auth-'));
	const cluster = await startDisposablePostgres();
	stopPostgres = cluster.stop;
	sql = cluster.clients[0];
	db = createDb(sql);
	await migrate(db, {
		migrationsFolder: fileURLToPath(
			new URL('../../../apps/api/drizzle/', import.meta.url),
		),
	});
	// The hosted deployment's two native clients (apps/api/worker/oauth-registrations.ts):
	// the Epicenter app's and the CLI's.
	await registerFirstPartyClients(db, {
		audiences,
		clients: [
			{
				clientId: 'so.epicenter',
				name: 'Epicenter',
				redirectUris: ['http://127.0.0.1/callback'],
				grantTypes: ['authorization_code', 'refresh_token'],
				scopes: everyScope,
				resources: [audiences.api, audiences.folders],
				skipConsent: true,
				applicationType: 'native',
			},
			{
				clientId: 'so.epicenter.cli',
				name: 'Epicenter CLI',
				redirectUris: [],
				grantTypes: [
					'urn:ietf:params:oauth:grant-type:device_code',
					'refresh_token',
				],
				scopes: everyScope,
				resources: [audiences.api, audiences.folders],
				skipConsent: false,
				applicationType: 'native',
			},
		],
	});
	app = createServerApp<CloudEnv>({
		resolveOrigin: () => origin,
		resolveTrustedOrigins: () => [origin],
		resolveAudiences: resolveOAuthAudiences,
	});
	mountAuthRoutes(app, {
		setup: createCloudContextMiddleware({
			connect: async () => ({ db, close: async () => {} }),
			afterResponse: () => {},
			resolveAuthSecrets: () => ({ BETTER_AUTH_SECRET: secret }),
			oauthServer: true,
		}),
		serveAuthUiShell: (c) => c.html('<html>shell</html>'),
	});
	client = new OAuthTestClient(origin, sql, secret, async (url, init) =>
		app.fetch(new Request(url, init)),
	);
}, 60_000);

afterAll(async () => {
	await stopPostgres?.();
	await rm(scratch, { recursive: true, force: true });
});

/** A CLI on its own machine: its own keychain and lock directory. */
function machine(secrets: SecretStore = createMemorySecrets()): AuthContext {
	return {
		deployment,
		secrets,
		lockDir: join(scratch, crypto.randomUUID()),
		fetch: async (input, init) => {
			const form =
				typeof init.body === 'string' ? new URLSearchParams(init.body) : null;
			sent.push({
				path: new URL(input).pathname,
				grantType: form?.get('grant_type') ?? null,
			});
			return app.fetch(new Request(input, init));
		},
		now: Date.now,
	};
}

const refreshes = () =>
	sent.filter((request) => request.grantType === 'refresh_token').length;

/** The resource check every Epicenter resource runs, on this token. */
async function reaches(
	token: string,
	o: { audience: string; scope: OAuthScope; person: Person },
) {
	const { data, error } = await authorizeAccountRequest(db, {
		token,
		audience: o.audience,
		scope: o.scope,
	});
	if (error !== null) return error.status;
	return data.accountId === o.person.id ? 200 : 403;
}

/** Sign `ctx` in with the device grant, approving as `person` on the server. */
async function deviceLogin(ctx: AuthContext, person: Person) {
	const codes: DeviceCode[] = [];
	let approved = false;
	const result = await loginWithDevice(ctx, {
		onCode: (code) => codes.push(code),
		sleep: async () => {
			if (approved) return;
			approved = true;
			const approval = await client.approveDeviceCode({
				cookie: person.cookie,
				userCode: codes[0]!.userCode,
				clientId: 'so.epicenter.cli',
			});
			expect(approval.status).toBe(200);
		},
	});
	return { result, code: codes[0]! };
}

/**
 * The Epicenter app's sign-in as `person`: its own client, `so.epicenter`,
 * whose refresh token its shell keeps, never the CLI.
 */
function appSignIn(person: Person) {
	return client.codeGrant({
		clientId: 'so.epicenter',
		redirectUri: 'http://127.0.0.1:5555/callback',
		cookie: person.cookie,
		scope: 'openid offline_access folders:read folders:write folders:all',
		resource: [audiences.api, audiences.folders],
	});
}

test('device login: the code, approval on the server, and a grant that reaches the API and Git', async () => {
	const person = await client.person('device-person');
	const ctx = machine();
	const { result, code } = await deviceLogin(ctx, person);
	expect(result.error).toBeNull();
	expect(code.userCode).toBeString();
	expect(code.verificationUri).toStartWith(origin);

	const stored = result.data!;
	expect(stored.client).toBe('so.epicenter.cli');
	expect((await authStatus(ctx)).data).toEqual(
		expect.objectContaining({
			client: 'so.epicenter.cli',
			signedIn: true,
			account: { id: person.id, name: 'device-person' },
		}),
	);
	expect(stored.issuer).toBe(origin);
	expect(stored.account).toEqual({ id: person.id, name: 'device-person' });
	expect(stored.scope.split(' ').sort()).toEqual([...everyScope].sort());
	// The API token from the device exchange is cached, bound to the API.
	const api = stored.access[audiences.api]!;
	expect(api.expiresAt - Date.now()).toBeGreaterThan(7 * 3600_000);
	expect(
		await reaches(api.token, { audience: audiences.api, scope: 'ai', person }),
	).toBe(200);
	expect(
		await reaches(api.token, {
			audience: audiences.folders,
			scope: 'folders:read',
			person,
		}),
	).toBe(401);

	// The same grant mints a folders-audience token with write, which sync sends.
	const folders = await accessToken(ctx, audiences.folders);
	expect(folders.error).toBeNull();
	expect(folders.data!.expiresAt).toBeGreaterThan(Date.now() + 7 * 3600 * 1000);
	expect(
		await reaches(folders.data!.token, {
			audience: audiences.folders,
			scope: 'folders:write',
			person,
		}),
	).toBe(200);
}, 60_000);

test('a token is refreshed once for every concurrent caller, under the lock', async () => {
	const person = await client.person('concurrent');
	const ctx = machine();
	await deviceLogin(ctx, person);
	// Age the cached API token into the five-minute margin.
	const stored = (await readGrant(ctx)).data!;
	const aged: StoredGrant = {
		...stored,
		access: {
			[audiences.api]: {
				...stored.access[audiences.api]!,
				expiresAt: Date.now() + 60_000,
			},
		},
	};
	await ctx.secrets.set(`device ${origin}`, JSON.stringify(aged));

	const before = refreshes();
	const tokens = await Promise.all(
		Array.from({ length: 8 }, () => accessToken(ctx)),
	);
	expect(refreshes()).toBe(before + 1);
	expect(new Set(tokens.map((token) => token.data?.token)).size).toBe(1);
	expect(tokens[0]!.data!.token).not.toBe(aged.access[audiences.api]!.token);
	expect(
		await reaches(tokens[0]!.data!.token, {
			audience: audiences.api,
			scope: 'ai',
			person,
		}),
	).toBe(200);
}, 60_000);

test('a refresh token another writer replaced is retried once, and a replay after the reuse interval ends the sign-in', async () => {
	const person = await client.person('retry');
	const secrets = createMemorySecrets();
	const ctx = machine(secrets);
	await deviceLogin(ctx, person);
	const name = `device ${origin}`;
	const real = (await readGrant(ctx)).data!;

	// The first read inside the lock sees a token the server does not know;
	// the retry rereads the entry and succeeds with the real one.
	let reads = 0;
	const flaky: SecretStore = {
		...secrets,
		async get(key) {
			const text = await secrets.get(key);
			reads++;
			if (reads !== 2 || text === null) return text;
			return JSON.stringify({ ...real, refreshToken: 'ep_rt_unknown' });
		},
	};
	const retried = await accessToken({ ...ctx, secrets: flaky }, audiences.folders);
	expect(retried.error).toBeNull();

	// Inside the 60-second reuse interval, the token just spent gets the
	// same answer, so a process that lost the answer is not signed out.
	const spent = real.refreshToken;
	const current = (await readGrant(ctx)).data!;
	await secrets.set(
		name,
		JSON.stringify({ ...current, refreshToken: spent, access: {} }),
	);
	const replayed = await accessToken(ctx, audiences.folders);
	expect(replayed.data?.token).toBe(current.access[audiences.folders]!.token);

	// After the interval, the replay ends every CLI grant of this person, on
	// every machine; the Epicenter app's is another client's and survives.
	const elsewhere = machine();
	await deviceLogin(elsewhere, person);
	const epicenter = await appSignIn(person);
	await sql.query(
		'update oauth_refresh_token set rotation_replay_expires_at = $1 where rotation_replay_expires_at is not null and user_id = $2',
		[new Date(Date.now() - 1000), person.id],
	);
	await secrets.set(
		name,
		JSON.stringify({ ...current, refreshToken: spent, access: {} }),
	);
	const ended = await accessToken(ctx, audiences.folders);
	expect(ended.error?.name).toBe('SignInEnded');
	expect(ended.error?.message).toContain('epicenter auth login');
	const other = (await readGrant(elsewhere)).data!;
	expect(
		await reaches(other.access[audiences.api]!.token, {
			audience: audiences.api,
			scope: 'ai',
			person,
		}),
	).toBe(401);
	expect(
		(await client.refresh('so.epicenter.cli', other.refreshToken)).status,
	).toBe(400);
	expect(
		(await client.refresh('so.epicenter', epicenter.refresh_token!)).status,
	).toBe(200);
}, 60_000);

test("logout revokes the refresh token and every cached access token, and leaves the Epicenter app's sign-in", async () => {
	const person = await client.person('logout');
	const ctx = machine();
	await deviceLogin(ctx, person);
	const epicenter = await appSignIn(person);
	const folders = await accessToken(ctx, audiences.folders);
	// Each audience's token comes from a different rotation, so revoking the
	// refresh token alone would leave the older one live.
	const device = (await readGrant(ctx)).data!;
	expect(Object.keys(device.access).sort()).toEqual(
		[audiences.api, audiences.folders].sort(),
	);

	const out = await logout(ctx);
	expect(out.data).toEqual({ signedOut: true, revoked: true });
	expect((await readGrant(ctx)).data).toBeNull();
	expect((await accessToken(ctx)).error?.name).toBe('NotSignedIn');
	// Its tokens stop at the next request, and its refresh token is dead.
	expect(
		await reaches(device.access[audiences.api]!.token, {
			audience: audiences.api,
			scope: 'ai',
			person,
		}),
	).toBe(401);
	expect(
		await reaches(folders.data!.token, {
			audience: audiences.folders,
			scope: 'folders:read',
			person,
		}),
	).toBe(401);
	expect(
		(await client.refresh('so.epicenter.cli', device.refreshToken)).status,
	).toBe(400);
	// The Epicenter app's sign-in is untouched.
	expect(
		(await client.refresh('so.epicenter', epicenter.refresh_token!)).status,
	).toBe(200);
	expect((await logout(ctx)).data).toEqual({
		signedOut: false,
		revoked: false,
	});
}, 60_000);

test('a refresh already sent finishes its keychain write before a stop signal ends the process', async () => {
	const person = await client.person('stopped');
	const ctx = machine();
	await deviceLogin(ctx, person);
	const stored = (await readGrant(ctx)).data!;
	const dir = await mkdtemp(join(scratch, 'stop-'));
	// The server rotates the token, then its answer takes a while to arrive:
	// the moment a stop signal lands in.
	const rotated = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const answer = await app.fetch(
				new Request(`${origin}${url.pathname}${url.search}`, request),
			);
			if (url.pathname === '/auth/oauth2/token') {
				rotated.resolve();
				await Bun.sleep(500);
			}
			return answer;
		},
	});
	// The child's deployment is this server, so its keychain entry is named
	// by this server's origin.
	const keychain = join(dir, 'keychain.json');
	const name = `device ${server.url.origin}`;
	await writeFile(
		keychain,
		JSON.stringify({ [name]: JSON.stringify({ ...stored, access: {} }) }),
	);
	const script = join(dir, 'refresh.ts');
	await writeFile(
		script,
		`import { accessToken } from ${JSON.stringify(join(import.meta.dir, 'auth.ts'))};
const [file, origin, api, folders, lockDir] = process.argv.slice(2);
const read = async () => JSON.parse(await Bun.file(file).text());
const secrets = {
	get: async (key) => (await read())[key] ?? null,
	set: async (key, value) => Bun.write(file, JSON.stringify({ ...(await read()), [key]: value })),
	delete: async () => false,
};
await accessToken({ deployment: { origin, audiences: { api, folders } }, secrets, lockDir, fetch, now: Date.now }, api);
`,
	);
	const child = Bun.spawn(
		[
			process.execPath,
			script,
			keychain,
			server.url.origin,
			audiences.api,
			audiences.folders,
			join(dir, 'locks'),
		],
		{ stdout: 'ignore', stderr: 'pipe' },
	);
	try {
		const early = await Promise.race([
			rotated.promise.then(() => null),
			child.exited.then(async (code) => ({
				code,
				stderr: await new Response(child.stderr).text(),
			})),
		]);
		expect(early).toBeNull();
		child.kill('SIGTERM');
		expect(await child.exited).toBe(143);
	} finally {
		void server.stop(true);
	}
	const written = JSON.parse(
		JSON.parse(await Bun.file(keychain).text())[name],
	) as StoredGrant;
	expect(written.refreshToken).not.toBe(stored.refreshToken);
	expect(written.access[audiences.api]).toBeDefined();
	expect(
		(await client.refresh('so.epicenter.cli', written.refreshToken)).status,
	).toBe(200);
}, 60_000);
