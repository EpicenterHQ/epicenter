/**
 * Whispering's browser sign-in covers both of its audiences (decision 65):
 * one sign-in through `getAuth()`, the client the web build uses, against the
 * real authorization server on a disposable Postgres cluster and a `Bun.serve`
 * listener, with this deployment's first-party registrations. The same Account
 * then writes a recording to the person's repository through `openRemote` (the
 * Git audience, `folders:write`) and sends a transcription (the API audience,
 * `ai`), and no refresh token is left in the browser's storage.
 *
 * The browser is played by in-memory storage and a location whose `assign`
 * the test answers as the authorization server would for a signed-in person.
 * Requires initdb and pg_ctl on PATH; never connects to a configured database.
 */
import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCallbackAuthClient } from '@epicenter/auth';
import {
	APPS,
	localUrl,
	resolveOAuthAudiences,
} from '@epicenter/constants/apps';
import { defineContract } from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';
import { openRemote } from '@epicenter/folder/remote';
import { expectOk } from 'wellcrafted/testing';
import {
	type CloudEnv,
	createCloudContextMiddleware,
	createDb,
	createDiskGitHost,
	createServerApp,
	mountAuthRoutes,
	mountGitHost,
	registerFirstPartyClients,
	requireAccessToken,
} from '../../../../../packages/server/src/bun.js';
import { startDisposablePostgres } from '../../../../../packages/server/src/test-helpers/disposable-postgres.js';
import { OAuthTestClient } from '../../../../../packages/server/src/test-helpers/oauth-client.js';
import { buildFirstPartyClients } from '../../../../api/worker/oauth-registrations.js';

const notes = defineContract({
	name: 'whispering',
	collections: {
		recordings: {
			path: 'recordings/{id}.md',
			fields: { title: { type: 'string' } },
			required: ['title'],
		},
	},
});

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
			fileURLToPath(
				new URL('../../../../../packages/server/', import.meta.url),
			),
		)
	);
	await migrate(createDb(cluster.clients[0]), {
		migrationsFolder: fileURLToPath(
			new URL('../../../../api/drizzle/', import.meta.url),
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
	const host = createDiskGitHost({ root: join(scratch, 'git-store') });
	mountGitHost(app, {
		setup: createCloudContextMiddleware(context),
		resolveHost: () => host,
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

test('one Whispering sign-in writes to the folder over Git and transcribes over the API', async () => {
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
	process.env.VITE_EPICENTER_SERVER = origin;
	const { getAuth } = await import('./auth.js');
	const auth = getAuth();

	expectOk(await auth.startSignIn());
	expect(navigations).toHaveLength(1);
	// The authorization server answers for the signed-in person.
	const authorize = new URL(navigations[0]!);
	expect(authorize.searchParams.getAll('resource')).toEqual([
		origin,
		`${origin}/git`,
	]);
	const answer = await oauth.request(
		`${authorize.pathname}${authorize.search}`,
		{
			cookie: person.cookie,
		},
	);
	location.href = answer.headers.get('location') ?? '';
	expect(new URL(location.href).searchParams.get('code')).toBeString();
	if (!isCallbackAuthClient(auth)) throw new Error('Expected the web client');
	expectOk(await auth.completeSignIn());

	const state = auth.state;
	if (state.status !== 'signed-in')
		throw new Error('Expected a signed-in account');
	expect(state.account.principalId).toBe(person.id as never);
	for (const cells of [storage.cells, attempts.cells])
		for (const value of cells.values()) expect(value).not.toContain('ep_rt_');

	const remote = openRemote(notes, { account: state.account });
	const id = timeId();
	expectOk(
		await remote.recordings.create({ id, title: 'Over Git', body: 'hello\n' }),
	);
	expect(expectOk(await remote.recordings.get({ id })).title).toBe('Over Git');

	const transcribed = await state.account.fetch(
		`${origin}/v1/audio/transcriptions`,
		{ method: 'POST', body: new FormData() },
	);
	expect(transcribed.status).toBe(200);
	expect(await transcribed.json()).toEqual({ text: 'heard over Epicenter' });
	expect(reached).toEqual([
		{ path: '/v1/audio/transcriptions', principal: person.id },
	]);
}, 60_000);
