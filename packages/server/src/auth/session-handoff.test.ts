/**
 * First proof for independent session issuance against installed Better Auth.
 * Exercises real endpoints, single-use redemption, PKCE/callback/state binding,
 * independent revocation, and preservation of a stale hosted session's age.
 * These fixtures do not prove provider freshness or browser/native integration.
 */
import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { betterAuth } from 'better-auth';
import { type MemoryDB, memoryAdapter } from 'better-auth/adapters/memory';
import { bearer } from 'better-auth/plugins/bearer';
import { sessionHandoff } from './session-handoff.js';

const origin = 'http://localhost:8787';
const callback = 'http://localhost:5174/auth/callback';
const nativeCallback = 'epicenter://auth/callback';
const verifier = 'a'.repeat(64);
const state = 's'.repeat(43);

async function setup() {
	const db: MemoryDB = { user: [], account: [], session: [], verification: [] };
	const auth = betterAuth({
		baseURL: origin,
		basePath: '/auth',
		secret: 'independent-session-proof-secret-1234567890',
		database: memoryAdapter(db),
		emailAndPassword: { enabled: true },
		trustedOrigins: [origin, new URL(callback).origin],
		session: {
			expiresIn: 30 * 86400,
			updateAge: 86400,
			cookieCache: { enabled: false },
		},
		plugins: [
			bearer({ requireSignature: true }),
			sessionHandoff({ origin, callbacks: [callback, nativeCallback] }),
		],
	});
	const signup = await auth.handler(
		new Request(`${origin}/auth/sign-up/email`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				name: 'Alice',
				email: 'alice@example.com',
				password: 'password123',
			}),
		}),
	);
	expect(signup.status).toBe(200);
	const cookieHeader = signup.headers.get('set-cookie');
	assert(cookieHeader);
	const cookie = cookieHeader;
	const challengeBytes = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(verifier),
	);
	const challenge = Buffer.from(challengeBytes).toString('base64url');
	function post(
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
	async function issue(destination = callback) {
		const response = await post(
			'/session/authorize',
			{ callback: destination, challenge, state },
			{ cookie, origin },
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { url: string };
		const code = new URL(body.url).searchParams.get('code');
		assert(code);
		return code;
	}
	function redeem(
		code: string,
		overrides: Partial<{
			callback: string;
			verifier: string;
			state: string;
		}> = {},
	) {
		return post('/session/redeem', {
			callback,
			code,
			verifier,
			state,
			...overrides,
		});
	}
	async function read(token: string) {
		return auth.api.getSession({
			headers: new Headers({ authorization: `Bearer ${token}` }),
			query: { disableCookieCache: true },
		});
	}
	return { db, auth, cookie, challenge, post, issue, redeem, read };
}

test('browser and native callbacks issue independent sessions without replacing the hosted cookie', async () => {
	const { db, issue, redeem, read, post, auth, cookie } = await setup();
	const browser = await redeem(await issue());
	expect(browser.status).toBe(200);
	expect(browser.headers.get('set-cookie')).toBeNull();
	expect(browser.headers.get('cache-control')).toBe('no-store');
	const first = (await browser.json()) as { token: string };
	const native = await redeem(await issue(nativeCallback), {
		callback: nativeCallback,
	});
	expect(native.status).toBe(200);
	const second = (await native.json()) as { token: string };
	expect(first.token).not.toBe(second.token);
	expect(db.session).toHaveLength(3);
	expect((await read(first.token))?.user.email).toBe('alice@example.com');
	expect(
		(await post('/sign-out', {}, { authorization: `Bearer ${first.token}` }))
			.status,
	).toBe(200);
	expect(await read(first.token)).toBeNull();
	expect(await read(second.token)).not.toBeNull();
	expect(
		await auth.api.getSession({ headers: new Headers({ cookie }) }),
	).not.toBeNull();
});

test('concurrent redemption and replay mint exactly one session', async () => {
	const { db, issue, redeem } = await setup();
	const code = await issue();
	const results = await Promise.all([redeem(code), redeem(code), redeem(code)]);
	expect(results.map((result) => result.status).sort()).toEqual([
		200, 400, 400,
	]);
	expect((await redeem(code)).status).toBe(400);
	expect(db.session).toHaveLength(2);
});

for (const override of [
	{ verifier: 'b'.repeat(64) },
	{ state: 't'.repeat(43) },
	{ callback: nativeCallback },
]) {
	test(`a mismatched ${Object.keys(override)[0]} cannot redeem an intercepted code`, async () => {
		const { db, issue, redeem } = await setup();
		const code = await issue();
		expect((await redeem(code, override)).status).toBe(400);
		expect((await redeem(code)).status).toBe(400);
		expect(db.session).toHaveLength(1);
	});
}

test('issuance rejects unapproved callbacks, foreign origins, and bearer-based ceremonies', async () => {
	const { db, post, cookie, challenge } = await setup();
	for (const destination of [
		`${callback}/extra`,
		`${callback}?next=evil`,
		'https://attacker.example/auth/callback',
	]) {
		expect(
			(
				await post(
					'/session/authorize',
					{ callback: destination, challenge, state },
					{ origin, cookie },
				)
			).status,
		).toBe(400);
	}
	expect(
		(
			await post(
				'/session/authorize',
				{ callback, challenge, state },
				{ origin: 'https://attacker.example', cookie },
			)
		).status,
	).toBe(403);
	expect(
		(
			await post(
				'/session/authorize',
				{ callback, challenge, state },
				{ origin, cookie, authorization: 'Bearer bogus' },
			)
		).status,
	).toBe(403);
	expect(db.verification).toHaveLength(0);
});

test('an expired code or a revoked source session cannot issue a client session', async () => {
	const { db, issue, redeem } = await setup();
	const expired = await issue();
	const record = db.verification?.[0];
	assert(record);
	record.expiresAt = new Date(0);
	expect((await redeem(expired)).status).toBe(400);
	const revoked = await issue();
	assert(db.session);
	db.session.splice(0);
	expect((await redeem(revoked)).status).toBe(401);
	expect(db.session).toHaveLength(0);
});

test('issuance preserves stale authentication age through installed freshSessionMiddleware', async () => {
	const { db, issue, redeem, read, auth } = await setup();
	const stale = new Date(Date.now() - 3 * 86400_000);
	const source = db.session?.[0];
	assert(source);
	source.createdAt = stale;
	const response = await redeem(await issue());
	const { token } = (await response.json()) as { token: string };
	expect((await read(token))?.session.createdAt.getTime()).toBe(
		stale.getTime(),
	);
	// list-sessions uses the same installed fresh middleware as unlink-account.
	const sensitive = await auth.handler(
		new Request(`${origin}/auth/list-sessions`, {
			headers: { authorization: `Bearer ${token}` },
		}),
	);
	expect(sensitive.status).toBe(403);
	expect(((await sensitive.json()) as { code: string }).code).toBe(
		'SESSION_NOT_FRESH',
	);
});

test('ordinary bearer validation slides expiry without resetting authentication age', async () => {
	const { db, issue, redeem, read } = await setup();
	const response = await redeem(await issue());
	const { token } = (await response.json()) as { token: string };
	const session = db.session?.[1];
	assert(session);
	const createdAt = session.createdAt;
	session.expiresAt = new Date(Date.now() + 28 * 86400_000);
	const previousExpiry = session.expiresAt.getTime();
	const resolved = await read(token);
	assert(resolved);
	expect(resolved.session.expiresAt.getTime()).toBeGreaterThan(
		previousExpiry + 86400_000,
	);
	expect(resolved.session.createdAt).toEqual(createdAt);
});

test('redemption refuses ambient credentials and an unrelated browser origin', async () => {
	const { issue, post, cookie, db } = await setup();
	const code = await issue();
	const attempts: Record<string, string>[] = [
		{ cookie },
		{ authorization: 'Bearer bogus' },
		{ origin },
	];
	for (const headers of attempts) {
		const response = await post(
			'/session/redeem',
			{ callback, code, verifier, state },
			headers,
		);
		expect(response.status).toBe(400);
	}
	expect(db.session).toHaveLength(1);
});

test('issuance requires the hosted Origin even with a valid cookie', async () => {
	const { post, cookie, challenge } = await setup();
	expect(
		(
			await post(
				'/session/authorize',
				{ callback, challenge, state },
				{ cookie },
			)
		).status,
	).toBe(403);
});

test('a different deployment secret rejects the signed bearer even with the same database', async () => {
	const { db, issue, redeem } = await setup();
	const { token } = (await (await redeem(await issue())).json()) as {
		token: string;
	};
	const other = betterAuth({
		baseURL: 'http://localhost:8788',
		basePath: '/auth',
		secret: 'a-different-deployment-secret-1234567890',
		database: memoryAdapter(db),
		plugins: [bearer({ requireSignature: true })],
	});
	expect(
		await other.api.getSession({
			headers: new Headers({ authorization: `Bearer ${token}` }),
		}),
	).toBeNull();
});
