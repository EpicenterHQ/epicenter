/**
 * Runtime profile for the named-user self-hosted instance: which surfaces each of this
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
 * that. A separate test below verifies the admitted session and principal at
 * the store boundary; shared transport tests cover payload and socket behavior.
 */

import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSelfHostAuth } from '@epicenter/server/self-host-auth/bun';
import { createAuthenticator } from '../../packages/server/evidence/enrollment/authenticator.js';
import { API_ROUTES } from '@epicenter/constants/api-routes';

// The Worker entry re-exports the Durable Object authority, whose module imports
// `cloudflare:workers`. Only the class identity matters for route composition.
mock.module('cloudflare:workers', () => ({
	DurableObject: class {},
	WorkerEntrypoint: class {},
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
		surface: 'store sync',
		method: 'GET',
		url: `${ORIGIN}/api/store/v1/sync`,
		worker: 'served',
		bun: 'absent',
		why: 'The Worker reuses the shared Durable Object backend; no Bun store backend exists.',
	},
	{
		surface: 'generations list',
		method: 'GET',
		url: `${ORIGIN}/api/data/v1/test.notes/generations`,
		worker: 'served',
		bun: 'absent',
		why: 'The Worker reuses the shared Durable Object backend; no Bun store backend exists.',
	},
	{
		surface: 'generations import',
		method: 'POST',
		url: `${ORIGIN}/api/data/v1/test.notes/generations`,
		worker: 'served',
		bun: 'absent',
		why: 'The Worker reuses the shared Durable Object backend; no Bun store backend exists.',
	},
	{
		surface: 'generation bootstrap',
		method: 'GET',
		url: `${ORIGIN}/api/data/v1/test.notes/generations/1`,
		worker: 'served',
		bun: 'absent',
		why: 'The Worker reuses the shared Durable Object backend; no Bun store backend exists.',
	},
	{
		surface: 'named-user auth',
		method: 'GET',
		url: `${ORIGIN}/auth/get-session`,
		worker: 'served',
		bun: 'served',
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
		why: 'Admission removal belongs to internal operator commands; hosted account deletion is not mounted.',
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

const cleanup: (() => void | Promise<void>)[] = [];
afterAll(async () => {
	for (const close of cleanup.reverse()) await close();
});

/** Real passkey enrollment issues the bearer the Worker namespace fixture resolves. */
async function authenticationFixture() {
	const owner = openSelfHostAuth({
		path: ':memory:',
		origin: ORIGIN,
		callbacks: [],
	});
	cleanup.push(() => owner.close());
	const grant = await owner.auth.admit({ id: 'alice', name: 'Alice' });
	const post = (path: string, body: unknown, cookie?: string) =>
		owner.auth.handle(
			new Request(`${ORIGIN}/auth/${path}`, {
				method: 'POST',
				headers: {
					origin: ORIGIN,
					'content-type': 'application/json',
					...(cookie ? { cookie } : {}),
				},
				body: JSON.stringify(body),
			}),
		);
	const start = await post('passkey/registration-options', {
		token: grant.token,
	});
	const ceremony = (await start.json()) as {
		id: string;
		options: { challenge: string };
	};
	const binding = start.headers
		.getSetCookie()
		.map((cookie) => cookie.split(';')[0])
		.join('; ');
	const authenticator = await createAuthenticator(ORIGIN);
	const finish = await post(
		'passkey/register',
		{
			id: ceremony.id,
			response: await authenticator.register(ceremony.options.challenge),
		},
		binding,
	);
	if (finish.status !== 200) throw new Error('Fixture enrollment failed');
	const token = finish.headers
		.getSetCookie()
		.find((cookie) => cookie.startsWith('epicenter_session='))
		?.split(';')[0]
		?.slice('epicenter_session='.length);
	if (!token) throw new Error('Fixture session missing');
	return {
		auth: owner.auth,
		token,
		namespace: {
			idFromName(name: string) {
				if (name !== 'deployment') throw new Error('Unexpected auth owner');
				return name;
			},
			get() {
				return {
					fetch: (request: Request) => owner.auth.handle(request),
					resolveSession: (token: string) => owner.auth.resolveSession(token),
				};
			},
		},
	};
}

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
	const fixture = await authenticationFixture();
	const env = { API_PUBLIC_ORIGIN: ORIGIN, SELF_HOST_AUTH: fixture.namespace };
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
	const directory = mkdtempSync(join(tmpdir(), 'self-host-profile-'));
	const configured = {
		PORT: '8787',
		API_PUBLIC_ORIGIN: ORIGIN,
		AUTH_DB_PATH: join(directory, 'auth.sqlite'),
		SELF_HOST_CALLBACKS: '[]',
	};
	const previous = Object.fromEntries(
		Object.keys(configured).map((key) => [key, process.env[key]]),
	);
	const signals = ['SIGINT', 'SIGTERM'] as const;
	const listeners = signals.map((signal) => process.listeners(signal));
	Object.assign(process.env, configured);
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
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		const installed = signals.flatMap((signal, index) =>
			process
				.listeners(signal)
				.filter((listener) => !listeners[index]!.includes(listener))
				.map((listener) => ({ signal, listener })),
		);
		cleanup.push(async () => {
			await installed
				.find((entry) => entry.signal === 'SIGTERM')
				?.listener('SIGTERM');
			for (const { signal, listener } of installed)
				process.removeListener(signal, listener);
			rmSync(directory, { recursive: true, force: true });
		});
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

test('store routes resolve a live admitted session before addressing its principal backend', async () => {
	const { default: app } = await import('./worker/index.js');
	const addressed: string[] = [];
	const fixture = await authenticationFixture();
	const env = {
		API_PUBLIC_ORIGIN: ORIGIN,
		SELF_HOST_AUTH: fixture.namespace,
		GENERATIONS_LEDGER: {
			idFromName(name: string) {
				addressed.push(name);
				return name;
			},
			get() {
				return { list: () => [1] };
			},
		},
	};
	const request = (token: string) =>
		new Request(
			`${ORIGIN}/api/data/v1/test.notes/generations?principalId=somebody-else`,
			{ headers: { authorization: `Bearer ${token}` } },
		);
	for (const token of ['', 'wrong-token']) {
		expect((await app.fetch(request(token), env as never)).status).toBe(401);
	}
	expect(addressed).toEqual([]);
	const response = await app.fetch(request(fixture.token), env as never);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ generations: [1] });
	expect(addressed).toEqual(['principals/alice/data/test.notes']);
	await fixture.auth.revokeSession(fixture.token);
	expect((await app.fetch(request(fixture.token), env as never)).status).toBe(
		401,
	);
	expect(addressed).toHaveLength(1);
});

test('store upgrades resolve the subprotocol session and address only its principal authority', async () => {
	const { default: app } = await import('./worker/index.js');
	const addressed: string[] = [];
	const ledgers: string[] = [];
	const fixture = await authenticationFixture();
	const env = {
		API_PUBLIC_ORIGIN: ORIGIN,
		SELF_HOST_AUTH: fixture.namespace,
		GENERATIONS_LEDGER: {
			idFromName(name: string) {
				ledgers.push(name);
				return name;
			},
			get() {
				return { holds: (generation: number) => generation === 2 };
			},
		},
		STORE_AUTHORITY: {
			idFromName(name: string) {
				addressed.push(name);
				return name;
			},
			get() {
				return {
					fetch: () => new Response('authority reached', { status: 418 }),
				};
			},
		},
	};
	for (const [token, status] of [
		['invalid', 401],
		[fixture.token, 418],
	] as const) {
		const response = await app.fetch(
			new Request(
				`${ORIGIN}/api/store/v1/sync?dataId=test.notes&generation=2&principalId=other`,
				{
					headers: {
						upgrade: 'websocket',
						'sec-websocket-protocol': `epicenter, bearer.${token}`,
					},
				},
			),
			env as never,
		);
		expect(response.status).toBe(status);
	}
	for (const ledger of ledgers) expect(ledger).toBe('principals/alice/data/test.notes');
	expect(addressed).toEqual(['principals/alice/data/test.notes/generations/2']);
});
