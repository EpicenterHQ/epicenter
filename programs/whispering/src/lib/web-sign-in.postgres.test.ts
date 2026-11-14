/**
 * Whispering's browser sign-in holds its repository and its hosted models
 * (ADR-0786): one sign-in through `connectAccount`, as `app.ts` asks for
 * it, against the real authorization server on a disposable Postgres
 * cluster and a `Bun.serve` listener, with this deployment's first-party
 * registrations. It asks for the API audience first and the folders audience,
 * with `ai` and the `folders:*` scopes; the Account sends a transcription
 * over the API, and its first sync makes the folder attached to Whispering
 * (ADR-0811), which its token reaches. No refresh token is left in the browser's storage.
 *
 * The browser is played by in-memory storage and a location whose `assign`
 * the test answers as the authorization server would for a signed-in person.
 * Requires initdb and pg_ctl on PATH; never connects to a configured database.
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	APPS,
	localUrl,
	resolveOAuthAudiences,
} from '@epicenter/definition/site';
import { expectOk } from 'wellcrafted/testing';
import { buildFirstPartyClients } from '../../../../apps/api/worker/oauth-registrations.js';
import {
	type CloudEnv,
	createCloudContextMiddleware,
	createDb,
	createDiskBlobStore,
	createServerApp,
	mountAuthRoutes,
	mountFolders,
	registerFirstPartyClients,
	requireAccessToken,
} from '../../../../packages/server/src/bun.js';
import { startDisposablePostgres } from '../../../../packages/server/src/test-helpers/disposable-postgres.js';
import { OAuthTestClient } from '../../../../packages/server/src/test-helpers/oauth-client.js';

const secret = 'whispering-web-sign-in-secret-0123456789ab';
const appOrigin = localUrl(APPS.WHISPERING);

function memoryStorage() {
	const cells = new Map<string, string>();
	return {
		cells,
		getItem: (key: string) => cells.get(key) ?? null,
		setItem: (key: string, value: string) => void cells.set(key, value),
		removeItem: (key: string) => void cells.delete(key),
	};
}

let scratch: string;
let origin = '';
let stopPostgres: () => Promise<void>;
let server: ReturnType<typeof Bun.serve>;
let oauth: OAuthTestClient;
/** What reached the deployment's `/v1`, past its token check. */
const reached: { path: string; principal: string }[] = [];

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), 'whispering-web-sign-in-'));
	const cluster = await startDisposablePostgres();
	stopPostgres = cluster.stop;
	// Drizzle is the server's dependency, not Whispering's.
	const { migrate } = await import(
		Bun.resolveSync(
			'drizzle-orm/node-postgres/migrator',
			fileURLToPath(new URL('../../../../packages/server/', import.meta.url)),
		)
	);
	await migrate(createDb(cluster.clients[0]), {
		migrationsFolder: fileURLToPath(
			new URL('../../../../apps/api/drizzle/', import.meta.url),
		),
	});
	const app = createServerApp<CloudEnv>({
		resolveOrigin: () => origin,
		resolveTrustedOrigins: () => [origin],
		resolveAudiences: resolveOAuthAudiences,
	});
	server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch: (request) => app.fetch(request),
		idleTimeout: 60,
	});
	origin = `http://127.0.0.1:${server.port}`;
	// One connection: this test sends one request at a time.
	const db = createDb(cluster.clients[0]);
	await registerFirstPartyClients(db, {
		audiences: resolveOAuthAudiences(origin),
		clients: buildFirstPartyClients(origin),
	});
	const context = {
		connect: async () => ({ db, close: async () => {} }),
		afterResponse: () => {},
		resolveAuthSecrets: () => ({ BETTER_AUTH_SECRET: secret }),
	};
	mountAuthRoutes(app, {
		setup: createCloudContextMiddleware({ ...context, oauthServer: true }),
		serveAuthUiShell: (c) => c.html('<html>shell</html>'),
	});
	const blobs = createDiskBlobStore({ root: join(scratch, 'blobs') });
	mountFolders(app, {
		setup: createCloudContextMiddleware(context),
		resolveBlobs: () => blobs,
	});
	// The inference gateway's guard, in front of a route that answers as a
	// transcription would.
	app.post(
		'/v1/*',
		createCloudContextMiddleware(context),
		requireAccessToken({ audience: 'api', scope: 'ai' }),
		(c) => {
			reached.push({
				path: new URL(c.req.url).pathname,
				principal: c.var.principal.id,
			});
			return c.json({ text: 'heard over Epicenter' });
		},
	);
	oauth = new OAuthTestClient(origin, cluster.clients[0], secret);
}, 120_000);

afterAll(async () => {
	server?.stop(true);
	await stopPostgres?.();
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

test('one Whispering sign-in transcribes over the API and reaches the person’s repository', async () => {
	const person = await oauth.person('whispering-web');
	const storage = memoryStorage();
	const attempts = memoryStorage();
	const navigations: string[] = [];
	const location = {
		href: `${appOrigin}/recordings`,
		origin: appOrigin,
		assign: (url: string) => void navigations.push(url),
		replace(url: string) {
			location.href = url;
		},
	};
	Object.assign(globalThis, {
		localStorage: storage,
		sessionStorage: attempts,
		location,
	});
	// The web build's deployment, as `VITE_EPICENTER_SERVER` names it.
	const { connectAccount, isCallbackAuthClient } = await import(
		'@epicenter/account'
	);
	const auth = connectAccount({
		clientId: APPS.WHISPERING.id,
		api: origin,
		selfHosted: origin,
		automaticRenewal: false,
	});
	if (!isCallbackAuthClient(auth)) throw new Error('a browser sign-in');
	// What `app.ts` gives the account to, each saying what it needs.
	const { home } = await import('@epicenter/folder');
	const { hosted } = await import('@epicenter/ai');
	home({ site: APPS.WHISPERING.url, account: auth });
	hosted(auth);

	expectOk(await auth.startSignIn());
	expect(navigations).toHaveLength(1);
	// The authorization server answers for the signed-in person.
	const authorize = new URL(navigations[0]!);
	expect(authorize.searchParams.getAll('resource')).toEqual([
		origin,
		`${origin}/folders`,
	]);
	expect(authorize.searchParams.get('scope')?.split(' ').sort()).toEqual(
		['ai', 'folders:read', 'folders:write', 'offline_access', 'openid'].sort(),
	);
	const answer = await oauth.request(
		`${authorize.pathname}${authorize.search}`,
		{
			cookie: person.cookie,
		},
	);
	location.href = answer.headers.get('location') ?? '';
	expect(new URL(location.href).searchParams.get('code')).toBeString();
	expectOk(await auth.completeSignIn());

	const state = auth.state();
	if (state.status !== 'signed-in')
		throw new Error('Expected a signed-in account');
	expect(state.account.principalId).toBe(person.id as never);
	for (const cells of [storage.cells, attempts.cells])
		for (const value of cells.values()) expect(value).not.toContain('ep_rt_');

	const transcribed = await state.account.fetch(
		`${origin}/v1/audio/transcriptions`,
		{ method: 'POST', body: new FormData() },
	);
	expect(transcribed.status).toBe(200);
	expect(await transcribed.json()).toEqual({ text: 'heard over Epicenter' });
	expect(reached).toEqual([
		{ path: '/v1/audio/transcriptions', principal: person.id },
	]);

	// The sign-in's first sync makes Whispering's folder, attached to it,
	// and its token reaches that folder.
	const joined = await state.account.fetch(`${origin}/folders`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ create: true }),
	});
	expect(joined.status).toBe(201);
	const { folder } = (await joined.json()) as { folder: string };
	const changes = await state.account.fetch(
		`${origin}/folders/${folder}/changes`,
	);
	expect(changes.status).toBe(200);
}, 60_000);
