/**
 * Direct session handoff through the deployed Better Auth/Drizzle composition.
 * Each test owns a disposable Postgres cluster and two independent connections.
 * The subprocess race also isolates Better Auth's in-process verification locks.
 * Verifies single-use redemption, independent revocation, preserved authentication
 * age, and rejection after source revocation, source expiry, or code expiry.
 * The fresh deployment baseline contains no OAuth provider or JWKS tables.
 * Requires initdb and pg_ctl on PATH; never connects to a configured deployment DB.
 */
import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeSignature } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Client } from 'pg';
import * as schema from '../db/schema/index.js';
import { withDisposablePostgres } from '../test-helpers/disposable-postgres.js';
import { createAuth } from './create-auth.js';

const origin = 'https://api.example.test';
const clientOrigin = 'https://app.example.test';
const callback = `${clientOrigin}/auth/callback`;
const secret = 'disposable-postgres-handoff-secret-1234567890';
const verifier = 'v'.repeat(64);
const state = 's'.repeat(43);

async function hash(value: string) {
	return Buffer.from(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
	).toString('base64url');
}

async function setup([first, second]: readonly [Client, Client]) {
	const db = drizzle(first, { schema });
	await migrate(db, {
		migrationsFolder: fileURLToPath(
			new URL('../../../../apps/api/drizzle/', import.meta.url),
		),
	});
	const authOptions = {
		env: { BETTER_AUTH_SECRET: secret },
		baseURL: origin,
		trustedOrigins: [origin, clientOrigin],
		sessionCallbacks: [callback],
	};
	const hosted = createAuth({ ...authOptions, db });
	const other = createAuth({ ...authOptions, db: drizzle(second, { schema }) });
	const context = await hosted.$context;
	await other.$context;
	expect(hosted.options.emailAndPassword?.enabled).toBe(false);
	const principal = await context.internalAdapter.createUser({
		name: 'Alice',
		email: 'alice@example.test',
		emailVerified: true,
	});
	const source = await context.internalAdapter.createSession(
		principal.id,
		false,
	);
	assert(source);
	const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${source.token}.${await makeSignature(source.token, secret)}`)}`;
	const challenge = await hash(verifier);
	function post(
		auth: typeof hosted,
		path: string,
		body: unknown,
		headers: Record<string, string> = {},
	) {
		return auth.handler(
			new Request(`${origin}/auth${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body: JSON.stringify(body),
			}),
		);
	}
	async function issue() {
		const response = await post(
			hosted,
			'/session/authorize',
			{ callback, challenge, state },
			{ origin, cookie },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = (await response.json()) as { url: string };
		const destination = new URL(body.url);
		expect(destination.origin + destination.pathname).toBe(callback);
		expect(destination.searchParams.get('state')).toBe(state);
		const code = destination.searchParams.get('code');
		assert(code);
		return code;
	}
	function redeem(auth: typeof hosted, code: string) {
		return post(
			auth,
			'/session/redeem',
			{ callback, code, verifier, state },
			{ origin: clientOrigin },
		);
	}
	function read(auth: typeof hosted, token: string) {
		return auth.api.getSession({
			headers: new Headers({ authorization: `Bearer ${token}` }),
			query: { disableCookieCache: true },
		});
	}
	async function mint() {
		const response = await redeem(other, await issue());
		expect(response.status).toBe(200);
		expect(response.headers.get('set-cookie')).toBeNull();
		expect(response.headers.get('cache-control')).toBe('no-store');
		return ((await response.json()) as { token: string }).token;
	}
	return { db, hosted, other, source, cookie, issue, redeem, read, mint, post };
}

// ============================================================================
// Deployment adapter behavior
// ============================================================================

test('the fresh deployment baseline has direct session tables and no OAuth or JWKS tables', async () => {
	await withDisposablePostgres(async (clients) => {
		await setup(clients);
		const { rows } = await clients[0].query<{ tablename: string }>(
			"select tablename from pg_catalog.pg_tables where schemaname = 'public' order by tablename",
		);
		const tables = rows.map((row) => row.tablename);
		expect(tables.filter((name) => /oauth|jwks/i.test(name))).toEqual([]);
		expect(tables).toEqual([
			'account',
			'passkey',
			'session',
			'storage_observation',
			'user',
			'verification',
		]);
	});
}, 60_000);

test('separate Bun processes race one code into exactly one Postgres session', async () => {
	await withDisposablePostgres(async (clients, port) => {
		const { db, hosted, other, source, issue, redeem, read } =
			await setup(clients);
		const code = await issue();
		const workers = [0, 1].map(() =>
			Bun.spawn(
				[
					process.execPath,
					fileURLToPath(
						new URL(
							'../test-helpers/session-handoff-worker.ts',
							import.meta.url,
						),
					),
					JSON.stringify({
						port,
						options: {
							env: { BETTER_AUTH_SECRET: secret },
							baseURL: origin,
							trustedOrigins: [origin, clientOrigin],
							sessionCallbacks: [callback],
						},
					}),
				],
				{
					stdin: 'pipe',
					stdout: 'pipe',
					stderr: 'inherit',
					env: { PATH: process.env.PATH, TZ: 'UTC', NODE_ENV: 'test' },
					timeout: 15_000,
				},
			),
		);
		try {
			const readers = workers.map((worker) => worker.stdout.getReader());
			// Both workers have connected and initialized auth before either gets the code.
			const ready = await Promise.all(
				readers.map(async (reader) => {
					let line = '';
					const decoder = new TextDecoder();
					while (!line.endsWith('\n')) {
						const chunk = await reader.read();
						assert(!chunk.done, 'Worker exited before readiness');
						line += decoder.decode(chunk.value, { stream: true });
					}
					return JSON.parse(line) as {
						pid: number;
						backendPid: number;
					};
				}),
			);
			assert(ready[0] && ready[1]);
			expect(ready[0].pid).not.toBe(ready[1].pid);
			expect(ready[0].backendPid).not.toBe(ready[1].backendPid);
			for (const worker of workers) {
				worker.stdin.write(JSON.stringify({ callback, code, verifier, state }));
				worker.stdin.end();
			}
			const responses = await Promise.all(
				readers.map(async (reader) => {
					let output = '';
					const decoder = new TextDecoder();
					for (;;) {
						const chunk = await reader.read();
						if (chunk.done) break;
						output += decoder.decode(chunk.value, { stream: true });
					}
					return JSON.parse(output + decoder.decode()) as {
						status: number;
						cookie: string | null;
						body: { token?: string };
					};
				}),
			);
			expect(await Promise.all(workers.map((worker) => worker.exited))).toEqual(
				[0, 0],
			);
			expect(responses.map((response) => response.status).sort()).toEqual([
				200, 400,
			]);
			const winner = responses.find((response) => response.status === 200);
			assert(winner?.body.token);
			expect(winner.cookie).toBeNull();
			expect((await read(other, winner.body.token))?.user.id).toBe(
				source.userId,
			);
			expect(await db.select().from(schema.session)).toHaveLength(2);
			expect(await db.select().from(schema.verification)).toHaveLength(0);
			expect((await redeem(hosted, code)).status).toBe(400);
		} finally {
			for (const worker of workers) if (worker.exitCode === null) worker.kill();
			await Promise.all(workers.map((worker) => worker.exited));
		}
	});
}, 60_000);

test('two Postgres connections redeem the same code concurrently into exactly one session', async () => {
	await withDisposablePostgres(async (clients) => {
		const { db, hosted, other, source, issue, redeem, read } =
			await setup(clients);
		const pids = await Promise.all(
			clients.map((client) =>
				client.query<{ pid: number }>('select pg_backend_pid() as pid'),
			),
		);
		expect(pids[0]?.rows[0]?.pid).toBeNumber();
		expect(pids[1]?.rows[0]?.pid).toBeNumber();
		expect(pids[0]?.rows[0]?.pid).not.toBe(pids[1]?.rows[0]?.pid);
		const code = await issue();
		const responses = await Promise.all([
			redeem(hosted, code),
			redeem(other, code),
		]);
		expect(responses.map((response) => response.status).sort()).toEqual([
			200, 400,
		]);
		const winner = responses.find((response) => response.status === 200);
		assert(winner);
		expect(winner.headers.get('set-cookie')).toBeNull();
		const { token } = (await winner.json()) as { token: string };
		const resolved = await read(other, token);
		assert(resolved);
		expect(resolved.session.id).not.toBe(source.id);
		expect(resolved.user.id).toBe(source.userId);
		expect(await db.select().from(schema.session)).toHaveLength(2);
		expect(await db.select().from(schema.verification)).toHaveLength(0);
		expect((await redeem(hosted, code)).status).toBe(400);
		expect((await redeem(other, code)).status).toBe(400);
		expect(await db.select().from(schema.session)).toHaveLength(2);
	});
}, 60_000);

test('revoking a client leaves the hosted and sibling sessions alive, and hosted revocation leaves the sibling alive', async () => {
	await withDisposablePostgres(async (clients) => {
		const { db, hosted, other, source, cookie, mint, read, post } =
			await setup(clients);
		const firstToken = await mint();
		const secondToken = await mint();
		expect(firstToken).not.toBe(secondToken);
		expect(
			(
				await post(
					other,
					'/sign-out',
					{},
					{ authorization: `Bearer ${firstToken}` },
				)
			).status,
		).toBe(200);
		expect(await read(hosted, firstToken)).toBeNull();
		expect((await read(hosted, secondToken))?.user.id).toBe(source.userId);
		expect(
			(
				await hosted.api.getSession({
					headers: new Headers({ cookie }),
					query: { disableCookieCache: true },
				})
			)?.session.id,
		).toBe(source.id);
		expect(
			(await post(hosted, '/sign-out', {}, { origin, cookie })).status,
		).toBe(200);
		expect(
			await other.api.getSession({
				headers: new Headers({ cookie }),
				query: { disableCookieCache: true },
			}),
		).toBeNull();
		expect((await read(other, secondToken))?.user.id).toBe(source.userId);
		expect(await db.select().from(schema.session)).toHaveLength(1);
	});
}, 60_000);

test('a stale source keeps its authentication age and cannot gain freshness by handoff', async () => {
	await withDisposablePostgres(async (clients) => {
		const { db, hosted, other, source, mint, read } = await setup(clients);
		const stale = new Date(Date.now() - 11 * 60_000);
		await db
			.update(schema.session)
			.set({ createdAt: stale })
			.where(eq(schema.session.id, source.id));
		const token = await mint();
		const resolved = await read(hosted, token);
		assert(resolved);
		expect(resolved.session.createdAt).toEqual(stale);
		const rows = await db.select().from(schema.session);
		expect(rows).toHaveLength(2);
		for (const row of rows) expect(row.createdAt).toEqual(stale);
		const sensitive = await other.handler(
			new Request(`${origin}/auth/list-sessions`, {
				headers: { authorization: `Bearer ${token}` },
			}),
		);
		expect(sensitive.status).toBe(403);
		expect(((await sensitive.json()) as { code: string }).code).toBe(
			'SESSION_NOT_FRESH',
		);
	});
}, 60_000);

for (const invalidation of [
	'revoked source',
	'expired source',
	'expired code',
] as const) {
	test(`${invalidation} prevents redemption across connections and consumes the code`, async () => {
		await withDisposablePostgres(async (clients) => {
			const { db, hosted, other, source, cookie, issue, redeem, post } =
				await setup(clients);
			const code = await issue();
			switch (invalidation) {
				case 'revoked source':
					expect(
						(await post(hosted, '/sign-out', {}, { origin, cookie })).status,
					).toBe(200);
					break;
				case 'expired source':
					await db
						.update(schema.session)
						.set({ expiresAt: new Date(0) })
						.where(eq(schema.session.id, source.id));
					break;
				case 'expired code':
					await db
						.update(schema.verification)
						.set({ expiresAt: new Date(0) })
						.where(
							eq(
								schema.verification.identifier,
								`client-session:${await hash(code)}`,
							),
						);
					break;
			}
			expect((await redeem(other, code)).status).toBe(
				invalidation === 'expired code' ? 400 : 401,
			);
			expect((await redeem(hosted, code)).status).toBe(400);
			expect(await db.select().from(schema.verification)).toHaveLength(0);
			const remaining = await db.select().from(schema.session);
			expect(remaining.map((row) => row.id)).toEqual(
				invalidation === 'revoked source' ? [] : [source.id],
			);
		});
	}, 60_000);
}
