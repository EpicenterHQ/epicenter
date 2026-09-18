/**
 * Hosted account deletion refusal tests.
 *
 * Exercises the mounted route with isolated session fixtures. A valid request
 * cannot start partial deletion or report acceptance/completion; fresh-session
 * and principal binding checks remain enforced. These are refusal tests, not
 * evidence of storage erasure or durable workflow recovery.
 */
import { expect, test } from 'bun:test';
import type { CloudEnv } from '@epicenter/server';
import { Hono } from 'hono';
import { mountAccountDeletionApi } from './routes.js';

function fixture({
	createdAt = new Date(),
	expiresAt = new Date(Date.now() + 60_000),
	unavailable = false,
	missing = false,
} = {}) {
	const session = {
		session: { createdAt, expiresAt },
		user: { id: 'alice', email: 'alice@example.test' },
	};
	let reads = 0;
	const app = new Hono<CloudEnv>();
	mountAccountDeletionApi(app, {
		setup: async (c, next) => {
			c.set('auth', {
				options: { session: { freshAge: 600 } },
				api: {
					async getSession(input: {
						headers: Headers;
						query: { disableCookieCache: boolean; disableRefresh: boolean };
					}) {
						reads++;
						expect(input.headers.get('authorization')).toBe('Bearer fixture');
						expect(input.query).toEqual({
							disableCookieCache: true,
							disableRefresh: true,
						});
						if (unavailable) throw new Error('session store unavailable');
						return missing ? null : session;
					},
				},
			} as unknown as CloudEnv['Variables']['auth']);
			// Any attempted database deletion fails the response assertion below.
			c.set(
				'db',
				new Proxy({} as CloudEnv['Variables']['db'], {
					get() {
						throw new Error('deletion must not access storage');
					},
				}),
			);
			return next();
		},
	});
	return {
		get reads() {
			return reads;
		},
		request(
			headers: Record<string, string> = {
				authorization: 'Bearer fixture',
				'x-epicenter-principal': 'alice',
			},
		) {
			return app.request(
				'/api/account',
				{ method: 'DELETE', headers },
				new Proxy({} as CloudEnv['Bindings'], {
					get() {
						throw new Error('deletion must not access external bindings');
					},
				}),
			);
		},
	};
}

test('fresh requests and retries refuse before storage or external deletion', async () => {
	const account = fixture();
	for (let attempt = 0; attempt < 3; attempt++) {
		const response = await account.request();
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			data: null,
			error: { code: 'ACCOUNT_DELETION_UNAVAILABLE' },
		});
	}
	expect(account.reads).toBe(3);
	// A new request handler has no lost in-memory progress to resume.
	expect((await fixture().request()).status).toBe(503);
});

test('missing bearer is refused without reading the session', async () => {
	const account = fixture();
	expect((await account.request({})).status).toBe(401);
	expect(account.reads).toBe(0);
});

test('principal mismatch is refused', async () => {
	expect(
		(
			await fixture().request({
				authorization: 'Bearer fixture',
				'x-epicenter-principal': 'bob',
			})
		).status,
	).toBe(403);
});

test('stale sessions require reauthentication', async () => {
	const response = await fixture({
		createdAt: new Date(Date.now() - 600_000),
	}).request();
	expect(response.status).toBe(403);
	expect(await response.json()).toMatchObject({
		error: { code: 'SESSION_NOT_FRESH' },
	});
});

test('expired and revoked sessions are refused', async () => {
	expect((await fixture({ expiresAt: new Date(0) }).request()).status).toBe(
		401,
	);
	expect((await fixture({ missing: true }).request()).status).toBe(401);
});

test('session database failure does not claim deletion is accepted', async () => {
	const response = await fixture({ unavailable: true }).request();
	expect(response.status).toBe(503);
	expect(await response.json()).toMatchObject({
		error: { name: 'SessionUnavailable' },
	});
});
