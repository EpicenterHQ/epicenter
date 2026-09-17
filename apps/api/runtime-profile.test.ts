/**
 * Runtime profile for the hosted cloud: which surfaces each of this deployment's
 * two entries actually serves.
 *
 * Each `mount*` declares one reusable surface. This test pins down the part
 * each entry writes by hand: which surfaces it chose to mount.
 *
 * The Worker is the deployed hosted artifact; the Bun entry is local dev and the
 * runtime-parity smoke (ADR-0066). Four surfaces are Worker-only for reasons that
 * survive scrutiny, and each says so in its row. Everything the shared library can
 * mount on both is expected on both, so dropping one from the dev host (which is
 * how `/v1/audio/transcriptions` went missing) fails here.
 *
 * How the probe reads an entry's surface: send one request per row and ask only
 * whether the path routed at all. A mounted surface answers 401 (or 403, or 503
 * when unconfigured); an unmounted one answers Hono's 404. Every probe carries a
 * bearer so the `/api/*` CSRF gate is skipped, otherwise an unmounted mutating
 * path would 403 before it could 404. Nothing here asserts a status code beyond
 * that in the profile checks. Outage checks below additionally verify shell
 * availability and protected-operation rejection through both entrypoints.
 */

import { expect, mock, test } from 'bun:test';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { generateBlobId, REMOTE_BLOB_ROUTES } from '@epicenter/blobs';
import { GENERATIONS_ROUTE, STORE_SYNC_ROUTE } from '@epicenter/sync';
import { makeSignature } from 'better-auth/crypto';

// Exercise the real runtime compositions with a controllable database outage.
let databaseUnavailable = false;
let databaseCalls = 0;
class ProbeClient {
	async connect() {
		databaseCalls++;
		if (databaseUnavailable) throw new Error('Postgres unavailable');
	}
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

// The Worker entry re-exports Durable Objects whose modules import
// `cloudflare:workers`. Only the class identity matters for route composition.
mock.module('cloudflare:workers', () => ({ DurableObject: class {} }));

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

/** A blob id shaped for the `blob_[a-z0-9]{21}` route pattern. */
const PROBE_BLOB_ID = generateBlobId();

const PROFILE: Surface[] = [
	{
		surface: 'health',
		method: 'GET',
		url: ORIGIN,
		worker: 'served',
		bun: 'served',
	},
	{
		surface: 'mountSessionApp',
		method: 'GET',
		url: API_ROUTES.session.url(ORIGIN),
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
		surface: 'mountBlobsApp (collection)',
		method: 'POST',
		url: REMOTE_BLOB_ROUTES.collectionUrl(ORIGIN, 'so.epicenter.notes'),
		worker: 'served',
		bun: 'served',
	},
	{
		surface: 'mountBlobsApp (by id)',
		method: 'GET',
		url: REMOTE_BLOB_ROUTES.objectUrl(
			ORIGIN,
			'so.epicenter.notes',
			'probe',
			PROBE_BLOB_ID,
		),
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
		surface: 'account deletion',
		method: 'DELETE',
		url: `${ORIGIN}/api/account`,
		worker: 'served',
		bun: 'absent',
		why: 'Deletion is a hosted resource sweep. A dev host holds none of those resources, and a partial sweep is worse than no route.',
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
				// Bearer requests skip the `/api/*` CSRF gate, which would otherwise
				// answer 403 for an unmounted mutating path and hide its absence.
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
const bunFetcher = once(async () => {
	Object.assign(process.env, {
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
		entry.startBunApiServer();
	} finally {
		Bun.serve = realServe;
	}
	if (!captured) throw new Error('the Bun entry never called Bun.serve');
	return captured;
});

test('every surface absent on a runtime says why', () => {
	const undeclared = PROFILE.filter(
		(row) => !(row.worker === 'served' && row.bun === 'served') && !row.why,
	);
	expect(undeclared.map((row) => row.surface)).toEqual([]);
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

test('Worker public HTML shells and both runtimes unrelated 404s survive Postgres outage without database calls', async () => {
	const worker = await workerFetcher();
	const bun = await bunFetcher();
	databaseUnavailable = true;
	databaseCalls = 0;
	try {
		for (const path of [
			'/sign-in',
			'/session/callback',
			'/dashboard',
			'/dashboard/usage',
		]) {
			const response = await worker(new Request(`${ORIGIN}${path}`));
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('<html>Cloud UI</html>');
			if (path === '/sign-in' || path === '/session/callback') {
				expect(response.headers.get('cache-control')).toBe('no-store');
				expect(response.headers.get('referrer-policy')).toBe('no-referrer');
			}
		}
		// Bun intentionally delegates browser UI to Vite; its existing diagnostic
		// must remain available without consulting the shared pool.
		for (const path of ['/sign-in', '/session/callback']) {
			const response = await bun(new Request(`${ORIGIN}${path}`));
			expect(response.status).toBe(503);
			expect(await response.text()).toContain(
				'Hosted auth UI is served by the SvelteKit app',
			);
		}
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
			for (const [method, path] of [
				['DELETE', '/api/session'],
				['GET', '/api/blobs'],
				['PUT', `/api/blobs/${PROBE_BLOB_ID}`],
				['GET', '/v1/chat/completions'],
				['GET', '/v1/audio/transcriptions'],
				['POST', '/api/billing/plans'],
				['GET', '/api/account'],
				['POST', '/api/store/v1/sync'],
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
	const token = `probe.${await makeSignature('probe', 'runtime-profile-probe-secret-not-a-real-key')}`;
	databaseUnavailable = true;
	try {
		for (const [fetcher, runtime] of [
			[worker, 'worker'],
			[bun, 'bun'],
		] as const) {
			for (const row of PROFILE.filter(
				(row) =>
					row[runtime] === 'served' &&
					!['health', 'dashboard SPA'].includes(row.surface),
			)) {
				const callsBefore = databaseCalls;
				const response = await fetcher(
					new Request(row.url, {
						method: row.method,
						headers: { authorization: `Bearer ${token}` },
					}),
				);
				expect(response.status).toBeGreaterThanOrEqual(500);
				expect(databaseCalls).toBe(callsBefore + 1);
			}
		}
		for (const url of [
			`${ORIGIN}${STORE_SYNC_ROUTE.pattern}`,
			GENERATIONS_ROUTE.collection(ORIGIN, 'test.data'),
			GENERATIONS_ROUTE.item(ORIGIN, 'test.data', 1),
		]) {
			const callsBefore = databaseCalls;
			const response = await worker(
				new Request(url, {
					headers: { authorization: `Bearer ${token}` },
				}),
			);
			expect(response.status).toBe(500);
			expect(databaseCalls).toBe(callsBefore + 1);
		}
	} finally {
		databaseUnavailable = false;
	}
});
