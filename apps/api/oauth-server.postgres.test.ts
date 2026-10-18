/**
 * The OAuth 2.1 authorization server (ADR-0549) through this deployment's two
 * real entries, each a separate process over HTTP against a disposable
 * Postgres cluster with every migration applied:
 *
 * - the Bun entry, `bun server.ts` (the spike's check 4, plus checks 1, 3, 5);
 * - the Worker entry under `wrangler dev --local`, reaching Postgres through
 *   Hyperdrive's local connection string (the spike's check 2, plus 1, 3, 5).
 *
 * The resource check runs in this process against the same database, the way
 * every resource will run it, and a real access token reaches each entry's own
 * resource over HTTP: the repository listing. Each entry writes its own first-party registrations: the Bun entry at boot, the
 * Worker before its first authorization-server request, and concurrent writes
 * agree. Requires initdb and pg_ctl on PATH; never connects to a configured
 * database and never deploys.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	PRODUCTION_API_URL,
	resolveOAuthAudiences,
} from '@epicenter/constants/apps';
import type { RepositoryListing } from '@epicenter/constants/repositories';
import {
	authorizeResourceRequest,
	createDb,
	firstPartyClientRow,
	type OAuthAudiences,
	type OAuthScope,
	oauthResourceInputs,
	readAccessToken,
	registerFirstPartyClients,
} from '@epicenter/server/bun';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import {
	type DisposablePostgres,
	startDisposablePostgres,
} from '../../packages/server/src/test-helpers/disposable-postgres.js';
import {
	checkFlows,
	checkGrantTarget,
	checkRefreshFamily,
	checkSilentReauthorization,
	type OAuthHarness,
} from '../../packages/server/src/test-helpers/oauth-checks.js';
import { OAuthTestClient } from '../../packages/server/src/test-helpers/oauth-client.js';
import { buildFirstPartyClients } from './worker/oauth-registrations.js';

const apiRoot = import.meta.dir;
/** Postgres here sorts text bytewise (`--no-locale`); so does this. */
const bytewise = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const secret = 'oauth-entries-postgres-secret-0123456789';
let cluster: DisposablePostgres;

async function freePort() {
	const listener = createServer();
	await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
	const address = listener.address();
	await new Promise<void>((done) => listener.close(() => done()));
	if (!address || typeof address === 'string') throw new Error('no port');
	return address.port;
}

/** A fresh, migrated database on the cluster, and a connection to it. */
async function database(name: string) {
	await cluster.clients[0].query(`create database ${name}`);
	const url = `postgres://postgres:disposable@127.0.0.1:${cluster.port}/${name}`;
	const client = new Client({ connectionString: url });
	await client.connect();
	await migrate(createDb(client), {
		migrationsFolder: resolve(apiRoot, 'drizzle'),
	});
	return { url, client };
}

/** Wait for a spawned entry to print its ready line, or fail with its output. */
async function waitFor(
	process: ReturnType<typeof Bun.spawn>,
	ready: RegExp,
	timeoutMs: number,
) {
	const output: string[] = [];
	const decoder = new TextDecoder();
	const read = async (stream: ReadableStream<Uint8Array>) => {
		const reader = stream.getReader();
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) return;
			output.push(decoder.decode(chunk.value));
		}
	};
	void read(process.stdout as ReadableStream<Uint8Array>);
	void read(process.stderr as ReadableStream<Uint8Array>);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (ready.test(output.join(''))) return output;
		if (process.exitCode !== null) break;
		await Bun.sleep(100);
	}
	throw new Error(`entry did not start:\n${output.join('')}`);
}

/** The harness for one running entry: its origin, database, and clients. */
async function harnessFor(
	origin: string,
	client: Client,
): Promise<OAuthHarness> {
	const audiences: OAuthAudiences = resolveOAuthAudiences(origin);
	const db = createDb(client);
	// A registered client that asks for consent, beside the first-party ones.
	await registerFirstPartyClients(db, {
		audiences,
		clients: [
			...buildFirstPartyClients(origin),
			{
				clientId: 'test.untrusted',
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
	return {
		client: new OAuthTestClient(origin, client, secret),
		audiences,
		desktop: {
			clientId: 'so.epicenter',
			redirectUri: 'http://127.0.0.1:53111/callback',
		},
		browser: {
			clientId: 'so.epicenter.todos',
			redirectUri: 'http://localhost:5186/auth/callback',
		},
		cli: { clientId: 'so.epicenter.cli' },
		untrusted: {
			clientId: 'test.untrusted',
			redirectUri: 'http://127.0.0.1:53222/callback',
		},
		async resource(token, o) {
			// Git presents the token as a Basic password with any username.
			const authorization = o.basic
				? `Basic ${btoa(`x-access-token:${token}`)}`
				: `Bearer ${token}`;
			const { data, error } = await authorizeResourceRequest(db, {
				token: readAccessToken(authorization),
				audience: o.audience,
				scope: o.scope as OAuthScope,
				namespaceId: o.namespace,
			});
			return error
				? { status: error.status, challenge: error.challenge, body: error.body }
				: {
						status: 200,
						challenge: null,
						body: { accountId: data.accountId, role: data.role },
					};
		},
	};
}

function checks(
	name: string,
	runtime: 'bun' | 'cloudflare',
	harness: () => OAuthHarness,
) {
	describe(name, () => {
		test('is the entry it claims to be', async () => {
			const health = await harness().client.request('/');
			expect(await health.json()).toMatchObject({ runtime });
		});
		test(
			"a refresh family is one client's grants for one person",
			() => checkRefreshFamily(harness()),
			60_000,
		);
		test('end-to-end flows', () => checkFlows(harness()), 60_000);
		test('grant target', () => checkGrantTarget(harness()), 60_000);
		test(
			'silent re-authorization',
			() => checkSilentReauthorization(harness()),
			60_000,
		);
		test(
			'a real access token reaches its resources over HTTP',
			() => checkResourcesOverHttp(harness()),
			60_000,
		);
	});
}

/**
 * One person's Git-audience token lists their repositories; an API-audience
 * token is refused, since the listing is the Git audience's.
 */
async function checkResourcesOverHttp(h: OAuthHarness) {
	const { client } = h;
	const person = await client.person('http');
	const git = await client.codeGrant({
		...h.desktop,
		cookie: person.cookie,
		resource: [h.audiences.git],
	});
	const api = await client.codeGrant({
		...h.desktop,
		cookie: person.cookie,
		scope: 'ai folders:read folders:write',
		resource: [h.audiences.api],
	});
	const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

	const listing = await fetch(`${client.origin}/api/repos`, {
		headers: bearer(git.access_token),
	});
	expect(listing.status).toBe(200);
	expect(
		((await listing.json()) as RepositoryListing).namespaces.map((n) => n.id),
	).toEqual([person.personal]);
	const wrongAudience = await fetch(`${client.origin}/api/repos`, {
		headers: bearer(api.access_token),
	});
	expect(wrongAudience.status).toBe(401);
}

const running: { stop: () => Promise<void> }[] = [];
let bun: OAuthHarness;
let worker: OAuthHarness;
/** The client ids the Worker wrote before its first authorization response. */
let workerRegisteredClients: string[];
const scratch = await mkdtemp(join(tmpdir(), 'epicenter-oauth-entries-'));

beforeAll(async () => {
	cluster = await startDisposablePostgres();

	// The Bun entry: production's own boot, which also writes its
	// first-party registrations for its origin.
	{
		const port = await freePort();
		const origin = `http://127.0.0.1:${port}`;
		const { url, client } = await database('bun_entry');
		// The pages it serves are the built UI, as on a self-hosted server.
		if (!(await Bun.file(resolve(apiRoot, 'ui/build/fallback.html')).exists()))
			expect(
				Bun.spawnSync([process.execPath, 'run', 'build'], {
					cwd: resolve(apiRoot, 'ui'),
					stdout: 'ignore',
					stderr: 'inherit',
				}).exitCode,
			).toBe(0);
		const entry = Bun.spawn([process.execPath, 'server.ts'], {
			cwd: apiRoot,
			env: {
				PATH: process.env.PATH,
				// East of UTC by more than a token's lifetime, so a clock
				// comparison made in local time refuses every token.
				TZ: 'Asia/Tokyo',
				DATABASE_URL: url,
				PORT: String(port),
				API_PUBLIC_ORIGIN: origin,
				BETTER_AUTH_SECRET: secret,
				GOOGLE_CLIENT_ID: 'fixture',
				GOOGLE_CLIENT_SECRET: 'fixture',
				GITHUB_CLIENT_ID: 'fixture',
				GITHUB_CLIENT_SECRET: 'fixture',
				MICROSOFT_CLIENT_ID: 'fixture',
				MICROSOFT_CLIENT_SECRET: 'fixture',
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		running.push({
			stop: async () => {
				entry.kill();
				await entry.exited;
				await client.end();
			},
		});
		await waitFor(entry, /listening on/, 30_000);
		bun = await harnessFor(origin, client);
	}

	// The Worker entry under local workerd. The config is wrangler.jsonc
	// without its production route, Artifacts, assets, or required secrets.
	{
		const port = await freePort();
		const origin = `http://127.0.0.1:${port}`;
		const { url, client } = await database('worker_entry');
		const config = Bun.JSONC.parse(
			await Bun.file(resolve(apiRoot, 'wrangler.jsonc')).text(),
		) as Record<string, unknown> & { compatibility_flags: string[] };
		const configPath = join(scratch, 'wrangler.json');
		await writeFile(
			configPath,
			JSON.stringify({
				name: 'api-oauth-test',
				main: resolve(apiRoot, 'worker/index.ts'),
				compatibility_date: config.compatibility_date,
				compatibility_flags: config.compatibility_flags,
				send_metrics: false,
				hyperdrive: [
					{
						binding: 'HYPERDRIVE',
						id: '00000000000000000000000000000000',
						localConnectionString: url,
					},
				],
			}),
		);
		const entry = Bun.spawn(
			[
				resolve(apiRoot, 'node_modules/.bin/wrangler'),
				'dev',
				'--config',
				configPath,
				'--local',
				'--ip',
				'127.0.0.1',
				'--port',
				String(port),
				'--inspector-port',
				String(await freePort()),
				'--var',
				`API_PUBLIC_ORIGIN:${origin}`,
				'--var',
				`BETTER_AUTH_SECRET:${secret}`,
			],
			{
				cwd: scratch,
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					WRANGLER_SEND_METRICS: 'false',
					CI: '1',
				},
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		running.push({
			stop: async () => {
				entry.kill();
				await entry.exited;
				await client.end();
			},
		});
		const output = await waitFor(entry, /Ready on/, 90_000);
		const metadata = await fetch(
			`${origin}/.well-known/oauth-authorization-server/auth`,
		);
		if (metadata.status !== 200)
			throw new Error(
				`the Worker's first authorization response was ${metadata.status}:\n${output.join('')}`,
			);
		await metadata.body?.cancel();
		workerRegisteredClients = (
			await client.query<{ client_id: string }>(
				'select client_id from oauth_client order by client_id',
			)
		).rows.map((row) => row.client_id);
		worker = await harnessFor(origin, client);
	}
}, 180_000);

afterAll(async () => {
	for (const entry of running) await entry.stop();
	await cluster?.stop();
	await rm(scratch, { recursive: true, force: true });
}, 60_000);

checks('the Bun entry on Postgres', 'bun', () => bun);

test('the Bun entry serves the sign-in, consent, and device pages with every file they load', async () => {
	for (const path of ['/sign-in', '/consent', '/device']) {
		const page = await bun.client.request(path);
		expect(page.status).toBe(200);
		expect(page.headers.get('content-type')).toContain('text/html');
		const html = await page.text();
		const files = [...html.matchAll(/["'](\/_app\/[^"'?#]+)["']/g)].map(
			(match) => match[1]!,
		);
		// SvelteKit preloads the whole module graph of a page, so these are
		// every file it loads.
		expect(files.length).toBeGreaterThan(0);
		for (const file of new Set(files)) {
			const loaded = await bun.client.request(file);
			expect(loaded.status, file).toBe(200);
			await loaded.body?.cancel();
		}
	}
}, 60_000);

checks(
	'the Worker entry under wrangler dev --local, through Hyperdrive',
	'cloudflare',
	() => worker,
);

test('the Worker writes its first-party clients before its first authorization response', () => {
	const origin = worker.client.origin;
	expect(workerRegisteredClients).toEqual(
		buildFirstPartyClients(origin)
			.map((client) => client.clientId)
			.sort(bytewise),
	);
});

test('concurrent registrations of the hosted clients on a fresh database all succeed and agree', async () => {
	const { url, client: first } = await database('hosted_race');
	const others = await Promise.all(
		[1, 2, 3].map(async () => {
			const other = new Client({ connectionString: url });
			await other.connect();
			return other;
		}),
	);
	const connections = [first, ...others];
	try {
		const audiences = resolveOAuthAudiences(PRODUCTION_API_URL);
		const clients = buildFirstPartyClients(PRODUCTION_API_URL);
		// Isolates that start together, then the same isolates restarting.
		for (let round = 0; round < 3; round++)
			await Promise.all(
				connections.map((connection) =>
					registerFirstPartyClients(createDb(connection), {
						audiences,
						clients,
					}),
				),
			);
		const resources = await first.query(
			'select identifier, access_token_ttl, allowed_scopes from oauth_resource order by identifier',
		);
		expect(resources.rows).toEqual(
			oauthResourceInputs(audiences)
				.map((resource) => ({
					identifier: resource.identifier,
					access_token_ttl: resource.accessTokenTtl,
					allowed_scopes: resource.allowedScopes,
				}))
				.sort((a, b) => bytewise(a.identifier, b.identifier)),
		);
		const rows = await first.query(
			`select id, client_id, name, redirect_uris, grant_types, response_types, scopes,
			        skip_consent, application_type, token_endpoint_auth_method, require_pkce, disabled
			 from oauth_client order by client_id`,
		);
		expect(rows.rows).toEqual(
			clients
				.map(firstPartyClientRow)
				.map((row) => ({
					id: row.id,
					client_id: row.clientId,
					name: row.name,
					redirect_uris: row.redirectUris,
					grant_types: row.grantTypes,
					response_types: row.responseTypes,
					scopes: row.scopes,
					skip_consent: row.skipConsent,
					application_type: row.applicationType,
					token_endpoint_auth_method: row.tokenEndpointAuthMethod,
					require_pkce: row.requirePKCE,
					disabled: row.disabled,
				}))
				.sort((a, b) => bytewise(a.client_id, b.client_id)),
		);
		const links = await first.query(
			'select client_id, resource_id from oauth_client_resource order by client_id, resource_id',
		);
		expect(links.rows).toEqual(
			clients
				.flatMap((client) =>
					client.resources.map((resource_id) => ({
						client_id: client.clientId,
						resource_id,
					})),
				)
				.sort(
					(a, b) =>
						bytewise(a.client_id, b.client_id) ||
						bytewise(a.resource_id, b.resource_id),
				),
		);
	} finally {
		await Promise.all(connections.map((connection) => connection.end()));
	}
}, 60_000);
