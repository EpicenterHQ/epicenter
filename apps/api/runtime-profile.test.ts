/**
 * Runtime profile for the hosted cloud: which surfaces each of this deployment's
 * two entries actually serves.
 *
 * Each `mount*` declares one reusable surface. This test pins down the part
 * each entry writes by hand: which surfaces it chose to mount.
 *
 * The Worker is the deployed hosted artifact; the Bun entry is local dev and
 * self-host (ADR-0066). Two surfaces are Worker-only for reasons that survive
 * scrutiny, and each says so in its row. Everything the shared library can
 * mount on both is expected on both, so dropping one from the dev host (which is
 * how `/v1/audio/transcriptions` went missing) fails here.
 *
 * How the probe reads an entry's surface: send one request per row and ask only
 * whether the path routed at all. A mounted surface answers 401 (or 403, or 503
 * when unconfigured); an unmounted one answers Hono's 404. Nothing here asserts
 * a status code beyond that in the profile checks. Outage checks below
 * additionally verify shell availability and protected-operation rejection
 * through both entrypoints.
 */

import { expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { makeSignature } from 'better-auth/crypto';

// Exercise the real runtime compositions with a controllable database outage.
let databaseUnavailable = false;
let databaseCalls = 0;
class ProbeClient {
	// A pool's connect hands back a client to release, as the Bun entry's
	// boot-time registration transaction needs.
	async connect() {
		databaseCalls++;
		if (databaseUnavailable) throw new Error('Postgres unavailable');
		return this;
	}
	release() {}
	async end() {}
	async query() {
		databaseCalls++;
		if (databaseUnavailable) throw new Error('Postgres unavailable');
		return { rows: [] };
	}
	on() {}
}
mock.module('pg', () => ({
	default: { Client: ProbeClient, Pool: ProbeClient },
	Client: ProbeClient,
	Pool: ProbeClient,
}));

type Presence = 'served' | 'absent';

type Surface = {
	/** The library mount or deployment surface this row stands for. */
	surface: string;
	method: string;
	url: string;
	worker: Presence;
	bun: Presence;
	/** Required unless the surface is served on both runtimes. */
	why?: string;
};

/** The origin every probe and both entries answer on; the path is what matters. */
const ORIGIN = 'http://localhost:8787';

const PROFILE: Surface[] = [
	{
		surface: 'health',
		method: 'GET',
		url: ORIGIN,
		worker: 'served',
		bun: 'served',
	},
	{
		surface: 'mountInferenceApp',
		method: 'POST',
		url: API_ROUTES.ai.completions.url(ORIGIN),
		worker: 'served',
		bun: 'served',
	},
	{
		surface: 'mountTranscriptionApp',
		method: 'POST',
		url: API_ROUTES.ai.transcriptions.url(ORIGIN),
		worker: 'served',
		bun: 'served',
	},
	{
		surface: 'Repository listing',
		method: 'GET',
		url: `${ORIGIN}/api/repos`,
		worker: 'served',
		bun: 'served',
	},
	{
		surface: 'Git data plane',
		method: 'GET',
		url: `${ORIGIN}/git/aaaaaaaaaaaa/probe.git/info/refs?service=git-upload-pack`,
		worker: 'served',
		bun: 'served',
	},
	{
		surface: 'mountAuthRoutes',
		method: 'GET',
		url: `${ORIGIN}/auth/get-session`,
		worker: 'served',
		bun: 'served',
	},
	{
		surface: 'billing',
		method: 'GET',
		url: `${ORIGIN}/api/billing/plans`,
		worker: 'served',
		bun: 'absent',
		why: "Billing is the deployed hosted Worker's concern: it needs the Autumn secret and the after-response drain. The dev host meters nothing, which is also why its inference and transcription gateways carry no policy.",
	},
	{
		surface: 'dashboard SPA',
		method: 'GET',
		url: `${ORIGIN}/dashboard`,
		worker: 'served',
		bun: 'absent',
		why: 'The shell comes from the Worker `ASSETS` binding. In Bun dev, Vite serves apps/api/ui directly, so the fallback shell has no job.',
	},
];

type Fetcher = (request: Request) => Response | Promise<Response>;

async function readProfile(
	fetcher: Fetcher,
): Promise<Record<string, Presence>> {
	const observed: Record<string, Presence> = {};
	for (const row of PROFILE) {
		const response = await fetcher(
			new Request(row.url, {
				method: row.method,
				headers: { authorization: 'Bearer runtime-profile-probe' },
			}),
		);
		observed[row.surface] = response.status === 404 ? 'absent' : 'served';
	}
	return observed;
}

/** Each entry boots once for the whole file; both are stateful processes. */
function once(build: () => Promise<Fetcher>): () => Promise<Fetcher> {
	let pending: Promise<Fetcher> | undefined;
	return () => {
		pending ??= build();
		return pending;
	};
}

/** The Cloudflare entry, driven through the fetch handler it exports. */
const workerFetcher = once(async () => {
	const entry = await import('./worker/index.js');
	const env = {
		API_PUBLIC_ORIGIN: ORIGIN,
		BETTER_AUTH_SECRET: 'runtime-profile-probe-secret-not-a-real-key',
		HYPERDRIVE: { connectionString: 'postgres://probe@localhost:5432/probe' },
		ASSETS: {
			fetch: async () =>
				new Response('<html>Cloud UI</html>', {
					headers: { 'Content-Type': 'text/html' },
				}),
		},
	};
	const executionCtx = { waitUntil() {}, passThroughOnException() {} };
	return (request: Request) =>
		entry.default.fetch(request, env as never, executionCtx as never);
});

/**
 * The Bun entry, driven through the handler it hands to `Bun.serve`.
 *
 * `startBunApiServer` owns env validation, the pool, and the listener, and none
 * of that is worth splitting apart for a test. Swapping
 * `Bun.serve` for a recorder lets the entry boot exactly as it does in
 * production and hands back the composed app's `fetch`, with no port bound.
 */
/** The built pages the Bun entry serves: a shell and one asset. */
const uiDir = mkdtempSync(join(tmpdir(), 'epicenter-runtime-profile-ui-'));
mkdirSync(join(uiDir, '_app', 'immutable'), { recursive: true });
writeFileSync(join(uiDir, 'fallback.html'), '<html>Cloud UI</html>');
writeFileSync(join(uiDir, '_app', 'immutable', 'start.js'), 'export {};');

const bunFetcher = once(async () => {
	Object.assign(process.env, {
		API_UI_DIR: uiDir,
		DATABASE_URL: 'postgres://probe@localhost:5432/probe',
		BETTER_AUTH_SECRET: 'runtime-profile-probe-secret-not-a-real-key',
		GOOGLE_CLIENT_ID: 'probe',
		GOOGLE_CLIENT_SECRET: 'probe',
		GITHUB_CLIENT_ID: 'probe',
		GITHUB_CLIENT_SECRET: 'probe',
		MICROSOFT_CLIENT_ID: 'probe',
		MICROSOFT_CLIENT_SECRET: 'probe',
		API_PUBLIC_ORIGIN: ORIGIN,
	});
	const entry = await import('./server.js');
	const realServe = Bun.serve;
	let captured: Fetcher | undefined;
	try {
		// @ts-expect-error the recorder stands in for the real listener
		Bun.serve = (options: { fetch: Fetcher }) => {
			captured = options.fetch;
			return { port: 0, stop: () => {} };
		};
		await entry.startBunApiServer();
	} finally {
		Bun.serve = realServe;
	}
	if (!captured) throw new Error('the Bun entry never called Bun.serve');
	return captured;
});

test('the Cloudflare entry serves its declared profile', async () => {
	const fetcher = await workerFetcher();
	expect(await readProfile(fetcher)).toEqual(
		Object.fromEntries(PROFILE.map((row) => [row.surface, row.worker])),
	);
});

test('the Bun entry serves its declared profile', async () => {
	const fetcher = await bunFetcher();
	expect(await readProfile(fetcher)).toEqual(
		Object.fromEntries(PROFILE.map((row) => [row.surface, row.bun])),
	);
});

test('an unmounted path reads as absent on both runtimes', async () => {
	for (const fetcher of [await workerFetcher(), await bunFetcher()]) {
		const response = await fetcher(
			new Request(`${ORIGIN}/api/not-a-surface`, {
				method: 'DELETE',
				headers: { authorization: 'Bearer runtime-profile-probe' },
			}),
		);
		expect(response.status).toBe(404);
	}
});

test("both runtimes' public HTML shells and unrelated 404s survive Postgres outage without database calls", async () => {
	const worker = await workerFetcher();
	const bun = await bunFetcher();
	databaseUnavailable = true;
	databaseCalls = 0;
	try {
		const authPages = ['/sign-in', '/consent', '/device'];
		for (const path of [...authPages, '/dashboard', '/dashboard/usage']) {
			const response = await worker(new Request(`${ORIGIN}${path}`));
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('<html>Cloud UI</html>');
			if (authPages.includes(path)) {
				expect(response.headers.get('cache-control')).toBe('no-store');
				expect(response.headers.get('referrer-policy')).toBe('no-referrer');
			}
		}
		// Bun serves the same built shell, and its assets, from disk.
		for (const path of authPages) {
			const response = await bun(new Request(`${ORIGIN}${path}`));
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('<html>Cloud UI</html>');
			expect(response.headers.get('cache-control')).toBe('no-store');
		}
		const asset = await bun(new Request(`${ORIGIN}/_app/immutable/start.js`));
		expect(asset.status).toBe(200);
		expect(asset.headers.get('cache-control')).toContain('immutable');
		for (const path of [
			'/_app/..%2ffallback.html',
			'/_app/%2e%2e/fallback.html',
			'/_app/immutable',
			'/_app/missing.js',
		])
			expect((await bun(new Request(`${ORIGIN}${path}`))).status).toBe(404);
		for (const fetcher of [worker, bun]) {
			for (const path of [
				'/missing',
				'/api/not-a-surface',
				'/v1/chat/unknown',
				'/v1/audio/unknown',
				'/api/billing/unknown',
			]) {
				expect((await fetcher(new Request(`${ORIGIN}${path}`))).status).toBe(
					404,
				);
			}
		}
		for (const fetcher of [worker, bun]) {
			// Epicenter hosts no MCP server and no blobs (ADR-0577).
			for (const [method, path] of [
				['POST', '/mcp'],
				['GET', '/.well-known/oauth-protected-resource/mcp'],
				['GET', '/api/blobs/personal/probe/public/AAAAAAAAAAAAAAAAAAAAAA'],
				['PUT', '/api/blobs/personal/probe/public/AAAAAAAAAAAAAAAAAAAAAA'],
				['GET', '/v1/chat/completions'],
				['GET', '/v1/audio/transcriptions'],
				['POST', '/api/billing/plans'],
				['GET', '/api/store/v1/sync'],
				['POST', '/api/store/v1/sync'],
				['POST', '/api/store/v1/current/so.epicenter.notes/personal/test.data'],
				['DELETE', '/api/data/v1/test.data/generations'],
				['POST', '/api/data/v1/test.data/generations/1'],
			]) {
				const response = await fetcher(
					new Request(`${ORIGIN}${path}`, {
						method,
						headers: { authorization: 'Bearer routing-probe' },
					}),
				);
				expect(response.status).toBe(404);
			}
		}
		expect(databaseCalls).toBe(0);
	} finally {
		databaseUnavailable = false;
	}
});

test('both runtime compositions fail closed on protected operations during a database outage', async () => {
	const worker = await workerFetcher();
	const bun = await bunFetcher();
	// An access token for the resources, and a session cookie for the
	// account-management routes, which read no Authorization header.
	const token = 'ep_at_runtime-profile-probe';
	const cookie = `better-auth.session_token=probe.${await makeSignature('probe', 'runtime-profile-probe-secret-not-a-real-key')}`;
	databaseUnavailable = true;
	try {
		for (const [fetcher, runtime] of [
			[worker, 'worker'],
			[bun, 'bun'],
		] as const) {
			// Neither entry has a Git store here, so the Git data plane answers
			// 503 before it reads Postgres.
			for (const row of PROFILE.filter(
				(row) =>
					row[runtime] === 'served' &&
					!['health', 'dashboard SPA', 'Git data plane'].includes(row.surface),
			)) {
				const callsBefore = databaseCalls;
				const response = await fetcher(
					new Request(row.url, {
						method: row.method,
						headers: { authorization: `Bearer ${token}`, cookie },
					}),
				);
				// The Worker opens its connection per request, before any route
				// runs, so every protected operation is Hono's bare 500. On Bun the
				// resources check the token and answer 503, while Better Auth's
				// session route answers its own 500.
				expect(response.status).toBe(
					runtime === 'worker' || row.surface === 'mountAuthRoutes' ? 500 : 503,
				);
				// On Bun the pool is already open, so the authorization server's
				// instance makes one more attempt: the provider seeding its
				// resources as it initializes. The Worker fails at connect.
				const attempts =
					runtime === 'bun' && row.surface === 'mountAuthRoutes' ? 2 : 1;
				expect(databaseCalls).toBe(callsBefore + attempts);
			}
		}
		for (const path of [
			'generations',
			'generations/initial',
			'generations/1',
		]) {
			for (const method of ['GET', 'POST']) {
				const callsBefore = databaseCalls;
				const response = await worker(
					new Request(`${ORIGIN}/api/data/v1/test.data/${path}`, {
						method,
						headers: { authorization: `Bearer ${token}` },
					}),
				);
				expect(response.status).toBe(404);
				expect(databaseCalls).toBe(callsBefore);
			}
		}
	} finally {
		databaseUnavailable = false;
	}
});
