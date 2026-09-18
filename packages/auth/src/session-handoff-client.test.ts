/**
 * Session handoff client ceremony tests against Better Auth over Bun loopback.
 * Verify browser/native issuance, one-use persisted attempts, strict callbacks,
 * and orphan revocation after cancellation or supersession during redemption.
 * Memory-backed sessions do not prove Postgres atomicity, real IdPs, or Tauri.
 */
import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { type MemoryDB, memoryAdapter } from 'better-auth/adapters/memory';
import { bearer } from 'better-auth/plugins/bearer';
import { sessionHandoff } from '../../server/src/auth/session-handoff.js';
import { createSessionHandoffClient } from './session-handoff-client.js';

const browserCallback = 'https://app.example/auth/callback';
const nativeCallback = 'epicenter://auth/callback';

async function setup(callback = browserCallback) {
	const db: MemoryDB = { user: [], account: [], session: [], verification: [] };
	let handler: (request: Request) => Promise<Response> = async () =>
		new Response(null, { status: 503 });
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: (request) => handler(request),
	});
	const baseURL = server.url.origin;
	const auth = betterAuth({
		baseURL,
		basePath: '/auth',
		secret: 'handoff-client-loopback-test-secret-1234567890',
		database: memoryAdapter(db),
		emailAndPassword: { enabled: true },
		trustedOrigins: [baseURL, new URL(browserCallback).origin],
		plugins: [
			bearer({ requireSignature: true }),
			sessionHandoff({
				origin: baseURL,
				callbacks: [browserCallback, nativeCallback],
			}),
		],
	});
	handler = auth.handler;
	try {
		const signup = await fetch(`${baseURL}/auth/sign-up/email`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				name: 'Alice',
				email: 'alice@example.com',
				password: 'password123',
			}),
		});
		expect(signup.status).toBe(200);
		const cookie = signup.headers
			.getSetCookie()
			.map((value) => value.split(';')[0])
			.join('; ');
		await signup.body?.cancel();
		const cells = new Map<string, string>();
		const storage = {
			getItem: (key: string) => cells.get(key) ?? null,
			setItem: (key: string, value: string) => {
				cells.set(key, value);
			},
		};
		const options = { baseURL, callback, storage };
		const client = createSessionHandoffClient(options);
		async function issue(begin: URL) {
			expect(begin.pathname).toBe('/sign-in');
			expect([...begin.searchParams.keys()].sort()).toEqual([
				'callback',
				'challenge',
				'state',
			]);
			const response = await fetch(`${baseURL}/auth/session/authorize`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: baseURL,
					cookie,
				},
				body: JSON.stringify(Object.fromEntries(begin.searchParams)),
			});
			expect(response.status).toBe(200);
			return new URL(((await response.json()) as { url: string }).url);
		}
		return {
			client,
			options,
			cells,
			issue,
			auth,
			db,
			[Symbol.dispose]() {
				void server.stop(true);
			},
		};
	} catch (error) {
		void server.stop(true);
		throw error;
	}
}

for (const callback of [browserCallback, nativeCallback]) {
	test(`${callback}: persisted attempt survives reconstruction and creates an independent session`, async () => {
		using context = await setup(callback);
		const { client, options, issue, auth, db, cells } = context;
		const returned = await issue(await client.begin());
		const token = await createSessionHandoffClient(options).complete(returned);
		expect(returned.href).not.toContain(token);
		expect(Object.keys(JSON.parse([...cells.values()][0]!))).toEqual([
			'version',
		]);
		expect(db.session).toHaveLength(2);
		expect(
			(
				await auth.api.getSession({
					headers: new Headers({ authorization: `Bearer ${token}` }),
				})
			)?.user.email,
		).toBe('alice@example.com');
		await expect(client.complete(returned)).rejects.toThrow();
	});
}

test('invalid callback destinations and duplicate parameters leave the valid attempt usable', async () => {
	using context = await setup();
	const { client, issue, cells } = context;
	const returned = await issue(await client.begin());
	for (const invalid of [
		`//app.example/auth/callback${returned.search}`,
		returned.href.replace('https:', 'http:'),
		returned.href.replace('app.example', 'other.example'),
		returned.href.replace('/auth/callback', '/auth/callback/extra'),
		returned.href.replace('app.example', 'user:password@app.example'),
		`${returned.href}#`,
		`${returned.href}#fragment`,
		`${returned.href}&state=duplicate`,
		`${returned.href}&code=duplicate`,
		`${returned.href}&token=unexpected`,
		browserCallback,
		returned.href.replace(/state=[^&]+/, 'state=wrong'),
	])
		await expect(client.complete(invalid)).rejects.toThrow();
	expect(cells.size).toBe(1);
	expect(await client.complete(returned)).toBeString();
});

test('native callbacks compare hosts despite opaque URL origins', async () => {
	using context = await setup(nativeCallback);
	const { client, issue } = context;
	const returned = await issue(await client.begin());
	await expect(
		client.complete(returned.href.replace('://auth/', '://other/')),
	).rejects.toThrow();
	expect(await client.complete(returned)).toBeString();
});

test('concurrent duplicate completion sends only one redemption', async () => {
	using context = await setup();
	const { client, issue, db } = context;
	const returned = await issue(await client.begin());
	const results = await Promise.allSettled([
		client.complete(returned),
		client.complete(returned),
	]);
	expect(results.map((result) => result.status).sort()).toEqual([
		'fulfilled',
		'rejected',
	]);
	expect(db.session).toHaveLength(2);
});

test('new begin supersedes stored attempts and cancel replaces the verifier with a tombstone', async () => {
	using context = await setup();
	const { client, issue, cells } = context;
	const old = await issue(await client.begin());
	const current = await issue(await client.begin());
	await expect(client.complete(old)).rejects.toThrow();
	client.cancel();
	expect(Object.keys(JSON.parse([...cells.values()][0]!))).toEqual(['version']);
	await expect(client.complete(current)).rejects.toThrow();
});

test('expired, future-dated, and corrupt persisted attempts cannot redeem', async () => {
	using context = await setup();
	const { client, issue, cells, db } = context;
	const returned = await issue(await client.begin());
	const [key, raw] = [...cells.entries()][0]!;
	for (const value of [
		JSON.stringify({ ...JSON.parse(raw), createdAt: Date.now() - 600_000 }),
		JSON.stringify({ ...JSON.parse(raw), createdAt: Date.now() + 60_000 }),
		JSON.stringify({ ...JSON.parse(raw), verifier: 'invalid' }),
		'broken JSON',
		'null',
	]) {
		cells.set(key, value);
		await expect(client.complete(returned)).rejects.toThrow();
	}
	expect(db.session).toHaveLength(1);
});

for (const action of ['cancel', 'begin', 'failed-cancel'] as const) {
	test(`${action} during redemption rejects the token and revokes only the orphan`, async () => {
		using context = await setup();
		const { options, issue, db, auth } = context;
		const received = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const revoked = Promise.withResolvers<void>();
		let orphan = '';
		let rejectWrites = false;
		const client = createSessionHandoffClient({
			...options,
			storage: {
				...options.storage,
				setItem(key, value) {
					if (rejectWrites) throw new Error('Storage unavailable');
					options.storage.setItem(key, value);
				},
			},
			async fetch(input, init) {
				expect(init?.credentials).toBe('omit');
				expect(init?.redirect).toBe('error');
				const response = await fetch(input, init);
				if (String(input).endsWith('/session/redeem')) {
					expect(
						Object.keys(JSON.parse([...context.cells.values()][0]!)),
					).toEqual(['version']);
					orphan = ((await response.json()) as { token: string }).token;
					received.resolve();
					await release.promise;
					return Response.json({ token: orphan });
				} else revoked.resolve();
				return response;
			},
		});
		const pending = client.complete(await issue(await client.begin()));
		const settled = pending.then(
			(token) => ({ token, error: null }),
			(error: unknown) => ({ token: null, error }),
		);
		await received.promise;
		if (action === 'failed-cancel') {
			rejectWrites = true;
			expect(() => client.cancel()).toThrow('Storage unavailable');
		}
		if (action === 'cancel') client.cancel();
		const next = action === 'begin' ? await client.begin() : null;
		release.resolve();
		const result = await settled;
		expect(result.token).toBeNull();
		expect(result.error).toBeInstanceOf(Error);
		expect(String(result.error)).toContain('cancelled or superseded');
		await revoked.promise;
		expect(
			await auth.api.getSession({
				headers: new Headers({ authorization: `Bearer ${orphan}` }),
			}),
		).toBeNull();
		expect(db.session).toHaveLength(1);
		if (next)
			expect(
				await createSessionHandoffClient(options).complete(await issue(next)),
			).toBeString();
	});
}

test('cancel during begin prevents its delayed digest from persisting', async () => {
	using context = await setup();
	const { client, cells } = context;
	const pending = client.begin();
	client.cancel();
	await expect(pending).rejects.toThrow('superseded');
	expect(Object.keys(JSON.parse([...cells.values()][0]!))).toEqual(['version']);
});

test('normalized callback URLs match while relative and credential-bearing configuration is refused', async () => {
	using context = await setup();
	const { options, issue } = context;
	for (const callback of [
		'//app.example/auth/callback',
		'https://user@app.example/auth/callback',
		`${browserCallback}#`,
		`${browserCallback}?next=other`,
	]) {
		expect(() =>
			createSessionHandoffClient({ ...options, callback }),
		).toThrow();
	}
	const client = createSessionHandoffClient({
		...options,
		callback: 'https://APP.EXAMPLE:443/auth/callback',
	});
	expect(await client.complete(await issue(await client.begin()))).toBeString();
});

test('a server refusal consumes the attempt and cannot be retried with the same callback', async () => {
	using context = await setup();
	const { client, issue, cells, db } = context;
	const returned = await issue(await client.begin());
	db.verification![0]!.expiresAt = new Date(0);
	await expect(client.complete(returned)).rejects.toThrow(
		'Session redemption failed (400)',
	);
	expect(Object.keys(JSON.parse([...cells.values()][0]!))).toEqual(['version']);
	await expect(client.complete(returned)).rejects.toThrow('missing');
});

test('overlapping begins leave only the newest attempt usable', async () => {
	using context = await setup();
	const { client, issue, cells } = context;
	const results = await Promise.allSettled([client.begin(), client.begin()]);
	expect(results[0]!.status).toBe('rejected');
	const newest = results[1]!;
	expect(newest.status).toBe('fulfilled');
	if (newest.status !== 'fulfilled') throw newest.reason;
	expect(cells.size).toBe(1);
	expect(await client.complete(await issue(newest.value))).toBeString();
});

test('storage failure prevents begin from returning a launch URL', async () => {
	using context = await setup();
	const { options } = context;
	const client = createSessionHandoffClient({
		...options,
		storage: {
			...options.storage,
			setItem() {
				throw new Error('Storage unavailable');
			},
		},
	});
	await expect(client.begin()).rejects.toThrow('Storage unavailable');
});

for (const action of ['complete', 'cancel'] as const) {
	test(`another instance's ${action} invalidates a delayed redemption after the pending verifier is gone`, async () => {
		using context = await setup();
		const { options, issue, auth, cells } = context;
		const received = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const revoked = Promise.withResolvers<void>();
		let orphan = '';
		const first = createSessionHandoffClient({
			...options,
			async fetch(input, init) {
				const response = await fetch(input, init);
				if (String(input).endsWith('/session/redeem')) {
					orphan = ((await response.json()) as { token: string }).token;
					received.resolve();
					await release.promise;
					return Response.json({ token: orphan });
				}
				expect(new Headers(init?.headers).get('authorization')).toBe(
					`Bearer ${orphan}`,
				);
				expect(response.status).toBe(200);
				revoked.resolve();
				return response;
			},
		});
		const pending = first.complete(await issue(await first.begin()));
		const settled = pending.then(
			(token) => ({ token, error: null }),
			(error: unknown) => ({ token: null, error }),
		);
		await received.promise;
		const second = createSessionHandoffClient(options);
		let successor: string | undefined;
		if (action === 'complete') {
			successor = await second.complete(await issue(await second.begin()));
		} else second.cancel();
		const tombstone = [...cells.values()][0]!;
		expect(Object.keys(JSON.parse(tombstone))).toEqual(['version']);
		release.resolve();
		const result = await settled;
		expect(result.token).toBeNull();
		expect(String(result.error)).toContain('cancelled or superseded');
		await revoked.promise;
		expect(
			await auth.api.getSession({
				headers: new Headers({ authorization: `Bearer ${orphan}` }),
			}),
		).toBeNull();
		expect([...cells.values()]).toEqual([tombstone]);
		if (successor) {
			expect(
				await auth.api.getSession({
					headers: new Headers({ authorization: `Bearer ${successor}` }),
				}),
			).not.toBeNull();
		}
	});
}
