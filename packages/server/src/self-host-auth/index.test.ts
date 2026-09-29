/**
 * Production self-host auth tests exercise real ES256 WebAuthn against SQLite.
 * They verify enrollment binding, durable recovery/removal, and independent PKCE sessions.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createLogger, memorySink } from 'wellcrafted/logger';
import { createAuthenticator } from '../../evidence/enrollment/authenticator.js';
import { createSelfHostAuth, type SelfHostAuthDatabase } from './index.js';

const origin = 'https://auth.example.test';
const callback = 'http://localhost:5173/auth/callback';
function setup() {
	const sqlite = new Database(':memory:');
	const database: SelfHostAuthDatabase = {
		all<T>(sql: string, ...bindings: (string | number | null)[]) {
			return sqlite.query(sql).all(...bindings) as T[];
		},
		run(sql, ...bindings) {
			sqlite.query(sql).run(...bindings);
		},
		transaction(operation) {
			return sqlite.transaction(operation)();
		},
	};
	const logs = memorySink();
	const auth = createSelfHostAuth({
		database,
		origin,
		callbacks: [callback],
		log: createLogger('auth-test', logs.sink),
	});
	async function request(
		path: string,
		body: unknown,
		cookie?: string,
		headers?: Record<string, string>,
	) {
		return auth.handle(
			new Request(origin + '/auth/' + path, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin,
					...(cookie ? { cookie } : {}),
					...headers,
				},
				body: JSON.stringify(body),
			}),
		);
	}
	async function enroll(id = 'alice') {
		const grant = await auth.admit({ id, name: id });
		const authenticator = await createAuthenticator(origin);
		const start = await request('passkey/registration-options', {
			token: grant.token,
		});
		const ceremony = (await start.json()) as {
			id: string;
			options: { challenge: string };
		};
		const response = await authenticator.register(ceremony.options.challenge);
		const finish = await request(
			'passkey/register',
			{ id: ceremony.id, response },
			cookies(start),
		);
		expect(finish.status).toBe(200);
		return {
			authenticator,
			cookie: cookies(finish),
			grant,
			ceremony,
			response,
		};
	}
	return { auth, sqlite, database, logs, request, enroll };
}
function cookies(response: Response) {
	return response.headers
		.getSetCookie()
		.map((value) => value.split(';')[0])
		.join('; ');
}
function token(cookie: string) {
	return cookie
		.split('; ')
		.find((part) => part.startsWith('__Host-epicenter_session='))!
		.split('=')[1]!;
}
async function challenge(verifier: string) {
	return Buffer.from(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
	).toString('base64url');
}

test('registration requires its browser cookie and consumes the grant once', async () => {
	const { auth, request } = setup();
	const grant = await auth.admit({ id: 'alice', name: 'Alice' });
	const start = await request('passkey/registration-options', {
		token: grant.token,
	});
	const ceremony = (await start.json()) as {
		id: string;
		options: { challenge: string };
	};
	const response = await (await createAuthenticator(origin)).register(
		ceremony.options.challenge,
	);
	expect(
		(await request('passkey/register', { id: ceremony.id, response })).status,
	).toBe(400);
	expect(
		(
			await request(
				'passkey/register',
				{ id: ceremony.id, response },
				cookies(start),
			)
		).status,
	).toBe(200);
	expect(
		(
			await request(
				'passkey/register',
				{ id: ceremony.id, response },
				cookies(start),
			)
		).status,
	).toBe(400);
	expect(
		(await request('passkey/registration-options', { token: grant.token }))
			.status,
	).toBe(400);
});

test('recovery immediately revokes sessions and old credentials while preserving identity', async () => {
	const { auth, request, enroll } = setup();
	const { cookie, authenticator } = await enroll();
	expect((await auth.resolveSession(token(cookie)))?.userId).toBe('alice');
	const recovery = await auth.recover('alice');
	expect(await auth.resolveSession(token(cookie))).toBeNull();
	const start = await request('passkey/authentication-options', {});
	const pending = (await start.json()) as {
		id: string;
		options: { challenge: string };
	};
	expect(
		(
			await request(
				'passkey/authenticate',
				{
					id: pending.id,
					response: await authenticator.authenticate(pending.options.challenge),
				},
				cookies(start),
			)
		).status,
	).toBe(400);
	const replacement = await request('passkey/registration-options', {
		token: recovery.token,
	});
	const pendingReplacement = (await replacement.json()) as {
		id: string;
		options: { challenge: string };
	};
	const registered = await request(
		'passkey/register',
		{
			id: pendingReplacement.id,
			response: await (await createAuthenticator(origin)).register(
				pendingReplacement.options.challenge,
			),
		},
		cookies(replacement),
	);
	expect((await auth.resolveSession(token(cookies(registered))))?.userId).toBe(
		'alice',
	);
});

test('removed users cannot complete pending enrollment or recover admission', async () => {
	const { auth, request } = setup();
	const grant = await auth.admit({ id: 'alice', name: 'Alice' });
	const start = await request('passkey/registration-options', {
		token: grant.token,
	});
	const pending = (await start.json()) as {
		id: string;
		options: { challenge: string };
	};
	const response = await (await createAuthenticator(origin)).register(
		pending.options.challenge,
	);
	auth.remove('alice');
	expect(
		(
			await request(
				'passkey/register',
				{ id: pending.id, response },
				cookies(start),
			)
		).status,
	).toBe(400);
	await expect(auth.recover('alice')).rejects.toThrow('not admitted');
});

test('real passkey login issues a session and rejects ceremony replay', async () => {
	const { request, enroll, auth } = setup();
	const { authenticator } = await enroll();
	const start = await request('passkey/authentication-options', {});
	const pending = (await start.json()) as {
		id: string;
		options: { challenge: string };
	};
	const response = await authenticator.authenticate(pending.options.challenge);
	const finish = await request(
		'passkey/authenticate',
		{ id: pending.id, response },
		cookies(start),
	);
	expect(finish.status).toBe(200);
	expect((await auth.resolveSession(token(cookies(finish))))?.userId).toBe(
		'alice',
	);
	expect(
		(
			await request(
				'passkey/authenticate',
				{ id: pending.id, response },
				cookies(start),
			)
		).status,
	).toBe(400);
});

test('PKCE handoff produces an independent bearer with original login freshness and bearer sign-out', async () => {
	const { auth, request, enroll, sqlite } = setup();
	const { cookie } = await enroll();
	const created = Date.now() - 60_000;
	sqlite.query('UPDATE auth_session SET created = ?').run(created);
	const verifier = 'v'.repeat(43);
	const state = 's'.repeat(32);
	const authorize = await request(
		'session/authorize',
		{ callback, challenge: await challenge(verifier), state },
		cookie,
	);
	const destination = new URL(
		((await authorize.json()) as { url: string }).url,
	);
	const body = {
		callback,
		verifier,
		state,
		code: destination.searchParams.get('code'),
	};
	const redeem = await request('session/redeem', body, undefined, {
		origin: new URL(callback).origin,
	});
	expect(redeem.status).toBe(200);
	expect(redeem.headers.has('set-cookie')).toBe(false);
	const issued = ((await redeem.json()) as { token: string }).token;
	expect(issued).not.toBe(token(cookie));
	expect((await auth.resolveSession(issued))?.createdAt).toBe(created);
	expect(
		(
			await request('session/redeem', body, undefined, {
				origin: new URL(callback).origin,
			})
		).status,
	).toBe(400);
	expect(
		(
			await request('sign-out', {}, undefined, {
				authorization: `Bearer ${issued}`,
			})
		).status,
	).toBe(200);
	expect(await auth.resolveSession(issued)).toBeNull();
	expect(await auth.resolveSession(token(cookie))).not.toBeNull();
});

test('wrong PKCE verifier burns a code and source revocation prevents redemption', async () => {
	const { auth, request, enroll } = setup();
	const { cookie } = await enroll();
	const verifier = 'v'.repeat(43);
	const state = 's'.repeat(32);
	async function issue() {
		const response = await request(
			'session/authorize',
			{ callback, challenge: await challenge(verifier), state },
			cookie,
		);
		return new URL(
			((await response.json()) as { url: string }).url,
		).searchParams.get('code');
	}
	const code = await issue();
	const headers = { origin: new URL(callback).origin };
	expect(
		(
			await request(
				'session/redeem',
				{ callback, verifier: 'w'.repeat(43), state, code },
				undefined,
				headers,
			)
		).status,
	).toBe(400);
	expect(
		(
			await request(
				'session/redeem',
				{ callback, verifier, state, code },
				undefined,
				headers,
			)
		).status,
	).toBe(400);
	const another = await issue();
	await auth.revokeSession(token(cookie));
	expect(
		(
			await request(
				'session/redeem',
				{ callback, verifier, state, code: another },
				undefined,
				headers,
			)
		).status,
	).toBe(400);
});

test('cross-origin browser ceremonies and ambient credentials at redemption are rejected', async () => {
	const { request, enroll } = setup();
	const { cookie } = await enroll();
	expect(
		(
			await request('passkey/authentication-options', {}, undefined, {
				origin: 'https://attacker.test',
			})
		).status,
	).toBe(400);
	expect(
		(
			await request('session/authorize', {}, cookie, {
				authorization: 'Bearer anything',
			})
		).status,
	).toBe(400);
	expect(
		(
			await request(
				'session/redeem',
				{
					callback,
					verifier: 'v'.repeat(43),
					state: 's'.repeat(32),
					code: 'invalid',
				},
				cookie,
			)
		).status,
	).toBe(400);
});

test('credential uniqueness failure rolls back grant consumption and session creation', async () => {
	const { auth, request, enroll, sqlite } = setup();
	const { authenticator } = await enroll();
	const grant = await auth.admit({ id: 'bob', name: 'Bob' });
	const start = await request('passkey/registration-options', {
		token: grant.token,
	});
	const pending = (await start.json()) as {
		id: string;
		options: { challenge: string };
	};
	const response = await authenticator.register(pending.options.challenge);
	expect(
		(
			await request(
				'passkey/register',
				{ id: pending.id, response },
				cookies(start),
			)
		).status,
	).toBe(503);
	expect(
		sqlite.query('SELECT * FROM auth_session WHERE user_id = ?').all('bob'),
	).toHaveLength(0);
	const replacement = await request('passkey/registration-options', {
		token: grant.token,
	});
	expect(replacement.status).toBe(200);
});

test('expired grants, ceremonies and sessions cannot publish or resolve access', async () => {
	const { auth, request, enroll, sqlite } = setup();
	const { cookie } = await enroll();
	sqlite.query('UPDATE auth_session SET expires = 0').run();
	expect(await auth.resolveSession(token(cookie))).toBeNull();
	const grant = await auth.admit({ id: 'bob', name: 'Bob' });
	const start = await request('passkey/registration-options', {
		token: grant.token,
	});
	const pending = (await start.json()) as {
		id: string;
		options: { challenge: string };
	};
	const response = await (await createAuthenticator(origin)).register(
		pending.options.challenge,
	);
	sqlite.query('UPDATE auth_ceremony SET expires = 0').run();
	expect(
		(
			await request(
				'passkey/register',
				{ id: pending.id, response },
				cookies(start),
			)
		).status,
	).toBe(400);
	sqlite.query('UPDATE auth_grant SET expires = 0').run();
	expect(
		(await request('passkey/registration-options', { token: grant.token }))
			.status,
	).toBe(400);
});

test('concurrent completion of one registration publishes exactly one session', async () => {
	const { auth, request, sqlite } = setup();
	const grant = await auth.admit({ id: 'alice', name: 'Alice' });
	const start = await request('passkey/registration-options', {
		token: grant.token,
	});
	const pending = (await start.json()) as {
		id: string;
		options: { challenge: string };
	};
	const response = await (await createAuthenticator(origin)).register(
		pending.options.challenge,
	);
	const responses = await Promise.all([
		request('passkey/register', { id: pending.id, response }, cookies(start)),
		request('passkey/register', { id: pending.id, response }, cookies(start)),
	]);
	expect(responses.map((response) => response.status).sort()).toEqual([
		200, 400,
	]);
	expect(sqlite.query('SELECT * FROM auth_session').all()).toHaveLength(1);
});

test('the legacy instance identity is reserved and insecure issuer and callback schemes are refused', async () => {
	const { auth, database } = setup();
	await expect(
		auth.admit({ id: 'instance', name: 'Instance' }),
	).rejects.toThrow('Invalid user identity');
	expect(() =>
		createSelfHostAuth({ database, origin: 'ftp://localhost', callbacks: [] }),
	).toThrow();
	for (const callback of [
		'javascript:alert(1)',
		'data:text/plain,hello',
		'ftp://localhost/auth/callback',
		'http://public.example/auth/callback',
		'epicenter://evil/callback',
	]) {
		expect(() =>
			createSelfHostAuth({ database, origin, callbacks: [callback] }),
		).toThrow();
	}
	expect(() =>
		createSelfHostAuth({
			database,
			origin,
			callbacks: [
				'epicenter://auth/callback',
				'https://app.example/auth/callback',
			],
		}),
	).not.toThrow();
});

test('HTTPS cookies use host prefixes with root paths and ignore sibling-domain plain cookies', async () => {
	const { request, enroll, auth } = setup();
	const { cookie } = await enroll();
	const start = await request('passkey/authentication-options', {});
	const header = start.headers.get('set-cookie')!;
	expect(header).toContain('__Host-epicenter_ceremony=');
	expect(header).toContain('Path=/;');
	expect(header).toContain('Secure');
	expect(header).not.toContain('Domain=');
	const response = await auth.handle(
		new Request(origin + '/auth/get-session', {
			headers: { cookie: cookie.replaceAll('__Host-', '') },
		}),
	);
	expect(await response.json()).toBeNull();
});

test('anonymous ceremony issuance has a durable deployment ceiling and retry response', async () => {
	const { request, database } = setup();
	database.run(
		'INSERT INTO auth_rate VALUES (1, ?, 60)',
		Math.floor(Date.now() / 60_000),
	);
	const response = await request(
		'passkey/authentication-options',
		{},
		undefined,
		{ 'x-forwarded-for': '1.2.3.4' },
	);
	expect(response.status).toBe(429);
	expect(response.headers.get('retry-after')).toBe('60');
	expect(database.all('SELECT * FROM auth_ceremony')).toHaveLength(0);
});

test('streamed bodies are capped without trusting content length and malformed JSON remains a client error', async () => {
	const { auth } = setup();
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new Uint8Array(128 * 1024));
		},
		cancel() {
			cancelled = true;
		},
	});
	const response = await auth.handle(
		new Request(origin + '/auth/passkey/authentication-options', {
			method: 'POST',
			headers: {
				origin,
				'content-type': 'application/json',
				'content-length': '1',
			},
			body: stream,
		}),
	);
	expect(response.status).toBe(413);
	expect(cancelled).toBe(true);
	const malformed = await auth.handle(
		new Request(origin + '/auth/passkey/authentication-options', {
			method: 'POST',
			headers: { origin, 'content-type': 'application/json' },
			body: '{',
		}),
	);
	expect(malformed.status).toBe(400);
});

test('database failures remain unavailable responses with sanitized structured diagnostics', async () => {
	const { auth, sqlite, logs } = setup();
	sqlite.close();
	const response = await auth.handle(
		new Request(origin + '/auth/get-session', {
			headers: { cookie: '__Host-epicenter_session=secret-do-not-log' },
		}),
	);
	expect(response.status).toBe(503);
	expect(logs.events).toHaveLength(1);
	expect(JSON.stringify(logs.events)).not.toContain('secret-do-not-log');
	expect(logs.events[0]?.level).toBe('error');
});
