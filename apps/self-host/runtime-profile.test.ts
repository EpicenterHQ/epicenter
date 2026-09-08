/**
 * Runtime profile for the single-partition instance: which surfaces each of this
 * deployment's two entries actually serves.
 *
 * Each `mount*` declares one reusable surface. This test pins down the part
 * each entry writes by hand: which surfaces it chose to mount.
 *
 * The table is the deployment's capability profile. Every row that is not
 * `served` on both runtimes must carry a `why`, so a divergence costs a sentence
 * instead of going unnoticed, and adding a surface to one entry without the other
 * fails here.
 *
 * How the probe reads an entry's surface: send one request per row and ask only
 * whether the path routed at all. A mounted surface answers 401 (or 403, or 503
 * when unconfigured); an unmounted one answers Hono's 404. Every probe carries a
 * bearer so the `/api/*` CSRF gate is skipped, otherwise an unmounted mutating
 * path would 403 before it could 404. Nothing here asserts a status code beyond
 * that: authorization, metering, and payload behavior are each surface's own
 * tests in `packages/server`.
 */

import { expect, mock, test } from 'bun:test';
import { API_ROUTES } from '@epicenter/constants/api-routes';

// The Worker entry re-exports the Durable Object authority, whose module imports
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
const PROBE_BLOB_ID = `blob_${'a'.repeat(21)}`;

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
		url: API_ROUTES.blobs.collection.url(ORIGIN),
		worker: 'served',
		bun: 'served',
	},
	{
		surface: 'mountBlobsApp (by id)',
		method: 'GET',
		url: API_ROUTES.blobs.byId.url(ORIGIN, PROBE_BLOB_ID),
		worker: 'served',
		bun: 'served',
	},
	{
		surface: 'mountAuthRoutes',
		method: 'GET',
		url: `${ORIGIN}/auth/get-session`,
		worker: 'absent',
		bun: 'absent',
		why: 'The relational-auth substrate is Cloud-only (ADR-0076). The instance composes no Better Auth and no sessions; the operator bearer is the only gate.',
	},
	{
		surface: 'billing',
		method: 'GET',
		url: `${ORIGIN}/api/billing/plans`,
		worker: 'absent',
		bun: 'absent',
		why: 'Billing is hosted-only and lives in `apps/api/worker/billing/` (ADR-0075). An instance must never grow it.',
	},
	{
		surface: 'hosted account deletion',
		method: 'DELETE',
		url: `${ORIGIN}/api/account`,
		worker: 'absent',
		bun: 'absent',
		why: 'The shared instance has no individual accounts. Its bearer does not grant an instance-wide reset operation.',
	},
	{
		surface: 'dashboard SPA',
		method: 'GET',
		url: `${ORIGIN}/dashboard`,
		worker: 'absent',
		bun: 'absent',
		why: 'The instance ships no dashboard and no Workers Static Assets binding; its clients are the Epicenter apps pointed at its origin.',
	},
];

/** A token that clears `assertStrongToken`'s entropy floor. */
const INSTANCE_TOKEN = `probe-${'k7Qm2xZ9'.repeat(5)}`;

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

/** The Cloudflare entry, driven through its exported Hono app. */
const workerFetcher = once(async () => {
	const entry = await import('./worker/index.js');
	const env = {
		API_PUBLIC_ORIGIN: ORIGIN,
		INSTANCE_TOKEN,
	};
	return (request: Request) => entry.default.fetch(request, env as never);
});

/**
 * The Bun entry, driven through the handler it hands to `Bun.serve`.
 *
 * `startSelfHostServer` owns env validation and the listener, and none of that
 * is worth splitting apart for a test. Swapping
 * `Bun.serve` for a recorder lets the entry boot exactly as it does in
 * production and hands back the composed app's `fetch`, with no port bound.
 */
const bunFetcher = once(async () => {
	Object.assign(process.env, {
		INSTANCE_TOKEN,
		PORT: '8787',
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
		entry.startSelfHostServer();
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
