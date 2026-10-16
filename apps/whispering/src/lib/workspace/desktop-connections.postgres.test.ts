/**
 * Whispering's transcription connection of kind `epicenter`, end to end on
 * the server: the app signs in through the CLI's loopback sign-in against the
 * real authorization server on a disposable Postgres cluster, a row in
 * `so.epicenter` names the Epicenter kind, and a request Whispering sends
 * over it goes through `ai_send` as the CLI's `send` runs it, with the app's
 * grant (`--desktop`), to the deployment's `/v1`. That route takes only an
 * access token for the API audience with `ai`, as inference does.
 *
 * `ai_send` and `auth_status` are answered in this process by the code
 * `epicenter send` and `epicenter auth status` run. Requires initdb and
 * pg_ctl on PATH; never connects to a configured database.
 */
import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectionsLens } from '@epicenter/ai/connection-table';
import {
	base64ToBytes,
	createMemorySecrets,
	responseEvents,
	sendRequest,
} from '@epicenter/ai/send';
import { resolveOAuthAudiences } from '@epicenter/constants/apps';
import { openFolder as openBunFolder } from '@epicenter/folder/bun';
import {
	type AuthContext,
	accountAccess,
	authStatus,
	epicenterAccess,
	loginWithLoopback,
	resolveDeployment,
} from '../../../../../packages/cli/src/auth.js';
import {
	type CloudEnv,
	createCloudContextMiddleware,
	createDb,
	createServerApp,
	mountAuthRoutes,
	registerFirstPartyClients,
	requireAccessToken,
} from '../../../../../packages/server/src/bun.js';
import { startDisposablePostgres } from '../../../../../packages/server/src/test-helpers/disposable-postgres.js';
import { OAuthTestClient } from '../../../../../packages/server/src/test-helpers/oauth-client.js';
import type { AuthStatus } from '../tauri/bindings.gen.js';
import type { ConnectionCommands } from './desktop-connections.js';

mock.module('@tauri-apps/api/core', () => ({
	transformCallback: () => 0,
	Channel: class {},
	isTauri: () => true,
	invoke: async () => {
		throw new Error('no shell in this test');
	},
}));

const { createDesktopConnections, CONNECTION_IDS } = await import(
	'./desktop-connections.js'
);

const origin = 'http://127.0.0.1:47915';
const secret = 'whispering-epicenter-connection-secret-012345';
const audiences = resolveOAuthAudiences(origin);

let stopPostgres: () => Promise<void>;
let scratch: string;
let app: ReturnType<typeof createServerApp<CloudEnv>>;
let ctx: AuthContext;
/** What reached the deployment's `/v1`, past its token check. */
const reached: { path: string; principal: string; body: string }[] = [];

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), 'whispering-epicenter-'));
	const cluster = await startDisposablePostgres();
	stopPostgres = cluster.stop;
	const sql = cluster.clients[0];
	const db = createDb(sql);
	// Drizzle is the server's dependency, not Whispering's.
	const { migrate } = await import(
		Bun.resolveSync(
			'drizzle-orm/node-postgres/migrator',
			fileURLToPath(
				new URL('../../../../../packages/server/', import.meta.url),
			),
		)
	);
	await migrate(db, {
		migrationsFolder: fileURLToPath(
			new URL('../../../../api/drizzle/', import.meta.url),
		),
	});
	// The desktop app's client (apps/api/worker/oauth-registrations.ts).
	await registerFirstPartyClients(db, {
		audiences,
		clients: [
			{
				clientId: 'so.epicenter',
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
		],
	});
	app = createServerApp<CloudEnv>({
		resolveOrigin: () => origin,
		resolveTrustedOrigins: () => [origin],
		resolveAudiences: resolveOAuthAudiences,
	});
	const context = {
		connect: async () => ({ db, close: async () => {} }),
		afterResponse: () => {},
		resolveAuthSecrets: () => ({ BETTER_AUTH_SECRET: secret }),
	};
	mountAuthRoutes(app, {
		setup: createCloudContextMiddleware({
			...context,
			oauthServer: {},
		}),
		serveAuthUiShell: (c) => c.html('<html>shell</html>'),
	});
	// The inference gateway's guard, in front of a route that answers as a
	// transcription would.
	app.post(
		'/v1/*',
		createCloudContextMiddleware(context),
		requireAccessToken({ audience: 'api', scope: 'ai' }),
		async (c) => {
			reached.push({
				path: new URL(c.req.url).pathname,
				principal: c.var.principal.id,
				body: await c.req.text(),
			});
			return c.json({ text: 'heard over Epicenter' });
		},
	);

	// Settings signs the app in: the loopback sign-in, the browser played by
	// requests carrying the person's session.
	const client = new OAuthTestClient(origin, sql, secret, async (url, init) =>
		app.fetch(new Request(url, init)),
	);
	const person = await client.person('whispering-epicenter');
	ctx = {
		deployment: resolveDeployment(origin),
		secrets: createMemorySecrets(),
		lockDir: join(scratch, 'locks'),
		fetch: async (input, init) => app.fetch(new Request(input, init)),
		now: Date.now,
	};
	const signedIn = await loginWithLoopback(ctx, {
		onUrl: async (url) => {
			const authorize = new URL(url);
			const answer = await client.request(
				`${authorize.pathname}${authorize.search}`,
				{ cookie: person.cookie },
			);
			void fetch(answer.headers.get('location') ?? '');
		},
	});
	expect(signedIn.error).toBeNull();
}, 60_000);

afterAll(async () => {
	await stopPostgres?.();
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

/** `auth_status` and `ai_send` as the CLI answers them with the app's grant. */
function shell(): ConnectionCommands {
	const fail = () => {
		throw new Error('an Epicenter connection has no keychain entry');
	};
	return {
		aiKeyState: fail,
		aiKeySet: fail,
		async authStatus() {
			const { data: grants, error } = await authStatus(ctx);
			if (error !== null) throw new Error(error.message);
			return {
				status: 'ok',
				data: { origin: ctx.deployment.origin, grants } as AuthStatus,
				error: null,
			};
		},
		async aiSend(target, request, channel) {
			const { data: response, error } = await sendRequest({
				target,
				request: {
					...request,
					body: request.body === null ? undefined : base64ToBytes(request.body),
				},
				secrets: ctx.secrets,
				epicenter: epicenterAccess(ctx, 'desktop'),
				account: accountAccess(ctx, 'desktop'),
				fetch: (async (input: Request | string | URL, init?: RequestInit) =>
					app.fetch(new Request(input, init))) as typeof fetch,
			});
			const deliver = (line: string) => channel.onmessage(line);
			if (error !== null) deliver(JSON.stringify({ type: 'error', ...error }));
			else
				for await (const event of responseEvents(response))
					deliver(JSON.stringify(event));
			const exit = { code: error === null ? 0 : 2, stderr: '' };
			deliver(JSON.stringify({ type: 'exit', ...exit }));
			return { status: 'ok', data: { ...exit, reply: null }, error: null };
		},
	} as ConnectionCommands;
}

test('a transcription over an Epicenter connection reaches the deployment’s /v1 with an ai token from the app’s sign-in', async () => {
	const root = join(scratch, 'so.epicenter');
	await mkdir(root);
	const opened = await openBunFolder({
		root,
		definition: connectionsLens,
		git: { author: { name: 'Test', email: 'test@localhost' } },
	});
	if (opened.error !== null) throw new Error(opened.error.message);
	const folder = opened.data;
	const { error: created } = await folder.tables.connections.create(
		{
			fields: { kind: 'epicenter', title: 'Epicenter', model: 'whisper-1' },
			body: '',
		},
		{ stem: CONNECTION_IDS.transcription },
	);
	expect(created).toBeNull();

	const connections = createDesktopConnections({
		commands: shell(),
		openConnections: async () => ({ data: folder, error: null }),
	});
	const info = await connections.read();
	expect(info.transcription).toMatchObject({
		baseUrl: `${origin}/v1`,
		model: 'whisper-1',
		keyPresent: true,
	});
	expect(info.transcription?.readOnlyReason).toContain('Epicenter’s Settings');
	// Whispering does not change a connection Settings owns.
	expect(
		(
			await connections.set('transcription', {
				baseUrl: 'https://api.example.test/v1',
				model: 'm',
				key: { action: 'remove' },
			})
		).error,
	).toContain('Epicenter’s Settings');

	const route = await connections.route('transcription');
	expect(route?.stored).toEqual({
		baseUrl: `${origin}/v1`,
		model: 'whisper-1',
	});
	const response = await route!.send(`${origin}/v1/audio/transcriptions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model: 'whisper-1' }),
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ text: 'heard over Epicenter' });
	expect(reached).toHaveLength(1);
	expect(reached[0]).toMatchObject({
		path: '/v1/audio/transcriptions',
		body: JSON.stringify({ model: 'whisper-1' }),
	});
	await connections.close();
}, 60_000);
