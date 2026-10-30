/**
 * The CLI's sign-ins against the real authorization server (ADR-0549,
 * ADR-0558): `@epicenter/server`'s composition in process, on a disposable
 * Postgres cluster with every migration applied, registering the desktop
 * and CLI clients as the hosted deployment does. The CLI reaches it through
 * an injected `fetch`; a person's approval is simulated through the consent
 * page's requests, as the server's checks do, and the browser's return to
 * the loopback listener is a real request to it. The keychain is a store in
 * memory. Requires initdb and pg_ctl on PATH; never connects to a configured
 * database.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemorySecrets, type SecretStore } from '@epicenter/ai/send';
import { resolveOAuthAudiences } from '@epicenter/constants/apps';
import {
	authorizeResourceRequest,
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
	configureGitHelper,
	type DeviceCode,
	gitCredential,
	loginWithDevice,
	loginWithLoopback,
	logout,
	readGrant,
	resolveDeployment,
	type StoredGrant,
} from './auth.ts';

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
	// The hosted deployment's two native clients (apps/api/worker/oauth-registrations.ts).
	await registerFirstPartyClients(db, {
		audiences,
		clients: [
			{
				clientId: 'so.epicenter',
				name: 'Epicenter',
				redirectUris: ['http://127.0.0.1/callback'],
				grantTypes: ['authorization_code', 'refresh_token'],
				scopes: everyScope,
				resources: [audiences.api, audiences.git],
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
				resources: [audiences.api, audiences.git],
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
	const { error } = await authorizeResourceRequest(db, {
		token,
		audience: o.audience,
		scope: o.scope,
		namespaceId: o.person.personal,
	});
	return error === null ? 200 : error.status;
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
				target: '*',
			});
			expect(approval.status).toBe(200);
		},
	});
	return { result, code: codes[0]! };
}

/** Sign `ctx` in through the loopback, the browser played by requests. */
async function loopbackLogin(ctx: AuthContext, person: Person) {
	let opened = '';
	const result = await loginWithLoopback(ctx, {
		onUrl: async (url) => {
			opened = url;
			const authorize = new URL(url);
			const answer = await client.request(
				`${authorize.pathname}${authorize.search}`,
				{ cookie: person.cookie },
			);
			expect(answer.status).toBe(302);
			const callback = answer.headers.get('location')!;
			expect(callback).toStartWith('http://127.0.0.1:');
			// The browser follows the redirect to the one-shot listener.
			void fetch(callback).then(async (page) => {
				expect(page.status).toBe(200);
				expect(await page.text()).toContain('Signed in to Epicenter');
			});
		},
	});
	return { result, opened };
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
			audience: audiences.git,
			scope: 'folders:read',
			person,
		}),
	).toBe(401);

	// The same grant mints a Git token with write, for git-credential.
	const answer = await gitCredential(
		ctx,
		'device',
		`protocol=http\nhost=127.0.0.1:47913\npath=git/${person.personal}/notes.git\n\n`,
	);
	const lines = Object.fromEntries(
		answer
			.data!.trim()
			.split('\n')
			.map((line) => line.split('=', 2)),
	);
	expect(lines.username).toBe('epicenter');
	expect(Number(lines.password_expiry_utc)).toBeGreaterThan(
		Date.now() / 1000 + 7 * 3600,
	);
	expect(
		await reaches(lines.password!, {
			audience: audiences.git,
			scope: 'folders:write',
			person,
		}),
	).toBe(200);
	// Git asking about another host gets no answer, and no request is made.
	const before = sent.length;
	expect(
		(await gitCredential(ctx, 'device', 'protocol=https\nhost=github.com\n\n'))
			.data,
	).toBeUndefined();
	expect(sent.length).toBe(before);
	// The desktop grant is a separate entry this login never touched.
	expect((await readGrant(ctx, 'desktop')).data).toBeNull();
}, 60_000);

test('loopback login: the desktop client on a one-shot listener, kept apart from the device grant', async () => {
	const person = await client.person('desktop-person');
	const ctx = machine();
	await deviceLogin(ctx, person);
	const { result, opened } = await loopbackLogin(ctx, person);
	expect(result.error).toBeNull();
	const url = new URL(opened);
	expect(url.origin + url.pathname).toBe(`${origin}/auth/oauth2/authorize`);
	expect(url.searchParams.get('client_id')).toBe('so.epicenter');
	expect(url.searchParams.get('code_challenge_method')).toBe('S256');
	expect(url.searchParams.get('redirect_uri')).toMatch(
		/^http:\/\/127\.0\.0\.1:\d+\/callback$/,
	);
	expect(url.searchParams.getAll('resource')).toEqual([
		audiences.api,
		audiences.git,
	]);
	expect(result.data!.client).toBe('so.epicenter');
	expect(result.data!.account?.id).toBe(person.id);

	// The exchange's API token is cached, so asking for it sends nothing.
	const before = refreshes();
	const api = await accessToken(ctx, 'desktop');
	expect(api.data?.token).toBe(result.data!.access[audiences.api]!.token);
	expect(refreshes()).toBe(before);
	const git = await accessToken(ctx, 'desktop', audiences.git);
	expect(
		await reaches(git.data!.token, {
			audience: audiences.git,
			scope: 'folders:write',
			person,
		}),
	).toBe(200);

	const status = await authStatus(ctx);
	expect(status.data).toEqual([
		expect.objectContaining({
			grant: 'device',
			client: 'so.epicenter.cli',
			signedIn: true,
		}),
		expect.objectContaining({
			grant: 'desktop',
			client: 'so.epicenter',
			signedIn: true,
			account: { id: person.id, name: 'desktop-person' },
		}),
	]);
	const device = (await readGrant(ctx, 'device')).data!;
	const desktop = (await readGrant(ctx, 'desktop')).data!;
	expect(device.refreshToken).not.toBe(desktop.refreshToken);
}, 60_000);

test('a token is refreshed once for every concurrent caller, under the lock', async () => {
	const person = await client.person('concurrent');
	const ctx = machine();
	await deviceLogin(ctx, person);
	// Age the cached API token into the five-minute margin.
	const stored = (await readGrant(ctx, 'device')).data!;
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
		Array.from({ length: 8 }, () => accessToken(ctx, 'device')),
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
	const real = (await readGrant(ctx, 'device')).data!;

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
	const retried = await accessToken(
		{ ...ctx, secrets: flaky },
		'device',
		audiences.git,
	);
	expect(retried.error).toBeNull();

	// Inside the 60-second reuse interval, the token just spent gets the
	// same answer, so a process that lost the answer is not signed out.
	const spent = real.refreshToken;
	const current = (await readGrant(ctx, 'device')).data!;
	await secrets.set(
		name,
		JSON.stringify({ ...current, refreshToken: spent, access: {} }),
	);
	const replayed = await accessToken(ctx, 'device', audiences.git);
	expect(replayed.data?.token).toBe(current.access[audiences.git]!.token);

	// After the interval, the replay ends every CLI grant of this person, on
	// every machine; the desktop grant is another client's and survives.
	const elsewhere = machine();
	await deviceLogin(elsewhere, person);
	const desktop = machine();
	await loopbackLogin(desktop, person);
	await sql.query(
		'update oauth_refresh_token set rotation_replay_expires_at = $1 where rotation_replay_expires_at is not null and user_id = $2',
		[new Date(Date.now() - 1000), person.id],
	);
	await secrets.set(
		name,
		JSON.stringify({ ...current, refreshToken: spent, access: {} }),
	);
	const ended = await accessToken(ctx, 'device', audiences.git);
	expect(ended.error?.name).toBe('SignInEnded');
	expect(ended.error?.message).toContain('epicenter auth login');
	const other = (await readGrant(elsewhere, 'device')).data!;
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
	const kept = await accessToken(desktop, 'desktop', audiences.git);
	expect(kept.error).toBeNull();
}, 60_000);

test('logout revokes the refresh token and every cached access token, and deletes only its entry', async () => {
	const person = await client.person('logout');
	const ctx = machine();
	await deviceLogin(ctx, person);
	await loopbackLogin(ctx, person);
	const git = await accessToken(ctx, 'device', audiences.git);
	// Each audience's token comes from a different rotation, so revoking the
	// refresh token alone would leave the older one live.
	const device = (await readGrant(ctx, 'device')).data!;
	expect(Object.keys(device.access).sort()).toEqual(
		[audiences.api, audiences.git].sort(),
	);

	const out = await logout(ctx, 'device');
	expect(out.data).toEqual({ signedOut: true, revoked: true });
	expect((await readGrant(ctx, 'device')).data).toBeNull();
	expect((await accessToken(ctx, 'device')).error?.name).toBe('NotSignedIn');
	// Its tokens stop at the next request, and its refresh token is dead.
	expect(
		await reaches(device.access[audiences.api]!.token, {
			audience: audiences.api,
			scope: 'ai',
			person,
		}),
	).toBe(401);
	expect(
		await reaches(git.data!.token, {
			audience: audiences.git,
			scope: 'folders:read',
			person,
		}),
	).toBe(401);
	expect(
		(await client.refresh('so.epicenter.cli', device.refreshToken)).status,
	).toBe(400);
	// The desktop grant is untouched.
	const desktop = await accessToken(ctx, 'desktop', audiences.git);
	expect(
		await reaches(desktop.data!.token, {
			audience: audiences.git,
			scope: 'folders:read',
			person,
		}),
	).toBe(200);
	expect((await logout(ctx, 'device')).data).toEqual({
		signedOut: false,
		revoked: false,
	});
}, 60_000);

test('a refresh already sent finishes its keychain write before a stop signal ends the process', async () => {
	const person = await client.person('stopped');
	const ctx = machine();
	await deviceLogin(ctx, person);
	const stored = (await readGrant(ctx, 'device')).data!;
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
const [file, origin, api, git, lockDir] = process.argv.slice(2);
const read = async () => JSON.parse(await Bun.file(file).text());
const secrets = {
	get: async (key) => (await read())[key] ?? null,
	set: async (key, value) => Bun.write(file, JSON.stringify({ ...(await read()), [key]: value })),
	delete: async () => false,
};
await accessToken({ deployment: { origin, audiences: { api, git } }, secrets, lockDir, fetch, now: Date.now }, 'device', api);
`,
	);
	const child = Bun.spawn(
		[
			process.execPath,
			script,
			keychain,
			server.url.origin,
			audiences.api,
			audiences.git,
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

test("login makes this CLI Git's helper for the deployment's Git origin in the global configuration", async () => {
	const home = await mkdtemp(join(scratch, 'home-'));
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		XDG_CONFIG_HOME: join(home, '.config'),
	};
	const configured = await configureGitHelper(
		machine(),
		['/Applications/Epicenter.app/Contents/MacOS/epicenter-cli'],
		env,
	);
	expect(configured.error).toBeNull();
	// Twice leaves one empty reset and one helper, not a growing list.
	await configureGitHelper(
		machine(),
		['/Applications/Epicenter.app/Contents/MacOS/epicenter-cli'],
		env,
	);
	const read = Bun.spawnSync(
		[
			'git',
			'config',
			'--file',
			join(home, '.gitconfig'),
			'--get-all',
			`credential.${new URL(audiences.git).origin}.helper`,
		],
		{ env },
	);
	expect(read.stdout.toString().split('\n')).toEqual([
		'',
		"!'/Applications/Epicenter.app/Contents/MacOS/epicenter-cli' auth git-credential",
		'',
	]);
});
