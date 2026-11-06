/**
 * The server a client's repository store talks to, whole, for a test or a
 * benchmark in another package: the authorization server on a disposable
 * Postgres, a `Bun.serve` listener, the disk Git and LFS stores, and a
 * signed-in person whose requests carry an access token from a real code
 * grant, reaching every folder they hold (`folders:all`), as the CLI does. Requires initdb and pg_ctl on PATH.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { compress } from 'hono/compress';
import { Pool } from 'pg';
import {
	type CloudEnv,
	createCloudContextMiddleware,
	createDb,
	createDiskGitHost,
	createDiskLfsStore,
	createServerApp,
	mountAuthRoutes,
	mountGitHost,
	registerFirstPartyClients,
} from '../bun.js';
import { startDisposablePostgres } from './disposable-postgres.js';
import { OAuthTestClient } from './oauth-client.js';

const secret = 'repository-server-secret-0123456789abcdef';
const client = {
	clientId: 'so.epicenter.sync-test',
	redirectUri: 'https://sync.example.test/auth/callback',
};

/** Start the server; `stop` tears down everything it made. */
export async function startRepositoryServer() {
	const scratch = await mkdtemp(join(tmpdir(), 'epicenter-repository-'));
	const cluster = await startDisposablePostgres();
	const sql = cluster.clients[0];
	await migrate(createDb(sql), {
		migrationsFolder: fileURLToPath(
			new URL('../../../../apps/api/drizzle/', import.meta.url),
		),
	});
	let origin = '';
	let audiences = { api: '', git: '' };
	const app = createServerApp<CloudEnv>({
		resolveOrigin: () => origin,
		resolveTrustedOrigins: () => [origin],
		resolveAudiences: () => audiences,
	});
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch: (request) => app.fetch(request),
		idleTimeout: 60,
	});
	origin = `http://127.0.0.1:${server.port}`;
	audiences = { api: origin, git: `${origin}/git` };
	const pool = new Pool({
		host: '127.0.0.1',
		port: cluster.port,
		user: 'postgres',
		database: 'postgres',
	});
	await registerFirstPartyClients(createDb(pool), {
		audiences,
		clients: [
			{
				clientId: client.clientId,
				name: 'Sync test',
				redirectUris: [client.redirectUri],
				grantTypes: ['authorization_code'],
				scopes: [
					'openid',
					'profile',
					'folders:read',
					'folders:write',
					'folders:all',
				],
				resources: [audiences.api, audiences.git],
				skipConsent: true,
				applicationType: 'web',
			},
		],
	});
	const requestDb = createDb(pool);
	const context = {
		connect: async () => ({ db: requestDb, close: async () => {} }),
		afterResponse: () => {},
		resolveAuthSecrets: () => ({ BETTER_AUTH_SECRET: secret }),
	};
	mountAuthRoutes(app, {
		setup: createCloudContextMiddleware({ ...context, oauthServer: true }),
		serveAuthUiShell: (c) => c.html('<html>shell</html>'),
	});
	const host = createDiskGitHost({ root: join(scratch, 'git-store') });
	const lfs = createDiskLfsStore({ root: join(scratch, 'lfs-store') });
	app.use('/git/*', compress());
	mountGitHost(app, {
		setup: createCloudContextMiddleware(context),
		resolveHost: () => host,
		resolveLfs: () => lfs,
	});
	const oauth = new OAuthTestClient(origin, sql, secret, async (url, init) =>
		app.fetch(new Request(url, init)),
	);

	return {
		origin,
		/**
		 * A signed-in person, as a repository store takes an account: every
		 * request to the server carries the token.
		 */
		async signIn(label: string) {
			const person = await oauth.person(label);
			const { access_token: token } = await oauth.codeGrant({
				...client,
				cookie: person.cookie,
				resource: [audiences.git],
				scope: 'openid folders:read folders:write folders:all',
			});
			const lifetime = new AbortController();
			return {
				baseURL: origin,
				signal: lifetime.signal,
				fetch(input: Request | string | URL, init?: RequestInit) {
					const headers = new Headers(init?.headers);
					headers.set('authorization', `Bearer ${token}`);
					return fetch(input, { ...init, headers, signal: lifetime.signal });
				},
				/** The email the person signs in with, which others share with. */
				email: person.email,
			};
		},
		async stop() {
			server.stop(true);
			await pool.end();
			await cluster.stop();
			await rm(scratch, { recursive: true, force: true });
		},
	};
}
